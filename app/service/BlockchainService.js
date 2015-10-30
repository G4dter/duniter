"use strict";

var path            = require('path');
var async           = require('async');
var _               = require('underscore');
var co               = require('co');
var Q               = require('q');
var sha1            = require('sha1');
var moment          = require('moment');
var inquirer        = require('inquirer');
var childProcess    = require('child_process');
var usage           = require('usage');
var base58          = require('../lib/base58');
var signature       = require('../lib/signature');
var constants       = require('../lib/constants');
var localValidator  = require('../lib/localValidator');
var globalValidator = require('../lib/globalValidator');
var blockchainDao   = require('../lib/blockchainDao');
var blockchainCtx   = require('../lib/blockchainContext');

module.exports = function (conf, dal, PeeringService) {
  return new BlockchainService(conf, dal, PeeringService);
};

var powFifo = async.queue(function (task, callback) {
  task(callback);
}, 1);

var cancels = [];

var statQueue = async.queue(function (task, callback) {
  task(callback);
}, 1);

// Callback used as a semaphore to sync block reception & PoW computation
var newKeyblockCallback = null;

// Callback used to start again computation of next PoW
var computeNextCallback = null;

// Flag indicating the PoW has begun
var computing = false;

var blockFifo = async.queue(function (task, callback) {
  task(callback);
}, 1);

function BlockchainService (conf, mainDAL, pair) {

  var that = this;
  var mainContext = blockchainCtx(conf, mainDAL);
  var logger = require('../lib/logger')(mainDAL.profile);
  var selfPubkey = base58.encode(pair.publicKey);

  var lastGeneratedWasWrong = false;

  var Identity      = require('../lib/entity/identity');
  var Certification = require('../lib/entity/certification');
  var Membership    = require('../lib/entity/membership');
  var Block         = require('../lib/entity/block');
  var Transaction   = require('../lib/entity/transaction');

  this.init = function(done) {
    return that.mainForkDAL()
      .then(function(dal){
        that.currentDal = dal;
        done();
      })
      .catch(done);
  };

  this.mainForkDAL = function() {
    return getCores()
      .then(function(cores){
        if (cores.length == 0) {
          // No cores yet: directly confirmed blockchain
          return mainDAL;
        }
        return Q(that.getMainFork(cores))
          .then(function(mainFork){
            return mainFork.dal;
          });
      });
  };

  this.mainFork = function() {
    return getCores()
      .then(function(cores){
        if (cores.length == 0) {
          // No cores yet: directly confirmed blockchain
          return mainContext;
        }
        return Q(that.getMainFork(cores));
      });
  };

  this.getMainFork = function(cores) {
    var maxNumber = _.max(cores, function(core) { return core.forkPointNumber; }).forkPointNumber;
    var highestCores = _.where(cores, { forkPointNumber: maxNumber });
    highestCores = _.sortBy(highestCores, function(core) { return core.forkPointHash; });
    return highestCores[highestCores.length - 1];
  };

  this.current = function (done) {
    return that.mainForkDAL()
      .then(function(forkDAL){
        return forkDAL.getCurrentBlockOrNull(done);
      })
      .then(function(bb){
        return bb;
      })
      .catch(done);
  };

  this.promoted = function (number, done) {
    return that.mainForkDAL()
      .then(function(forkDAL){
        return forkDAL.getPromoted(number, done);
      })
      .then(function(bb){
        return bb;
      })
      .catch(done);
  };

  this.checkBlock = function(block) {
    return that.mainFork()
      .then(function(mainFork){
        return mainFork.checkBlock(block);
      });
  };

  var coresLoaded;

  function getCores() {
    return (coresLoaded || (coresLoaded = mainDAL.getCores()
      .then(function(cores){
        cores = _.sortBy(cores, function(core) { return core.forkPointNumber; });
        return cores.reduce(function(p, core) {
          return p.then(function(){
            var basedCore = getCore(cores, core.forkPointNumber - 1, core.forkPointPreviousHash);
            var dal = basedCore ? basedCore.dal : mainDAL;
            return Q(dal.loadCore(core, constants.INVALIDATE_CORE_CACHE))
              .then(function(coreDAL){
                return blockchainCtx(conf, coreDAL);
              })
              .then(function(ctx){
                _.extend(core, ctx);
                return core;
              });
          });
        }, Q())
          .thenResolve(cores);
      })));
  }

  this.branches = function() {
    return getCores()
      .then(function(cores){
        var leaves = [];
        cores.forEach(function(core){
          if(_.where(cores, { forkPointNumber: core.forkPointNumber + 1, forkPointPreviousHash: core.forkPointHash }).length == 0) {
            leaves.push(core);
          }
        });
        return leaves;
      });
  };

  function getCore(cores, number, hash) {
    return  _.findWhere(cores, { forkPointNumber: number, forkPointHash: hash });
  }

  this.submitBlock = function (obj, doCheck) {
    var forkWindowSize = conf.branchesWindowSize;
    return Q.Promise(function(resolve, reject){
      // FIFO: only admit one block at a time
      blockFifo.push(function(blockIsProcessed) {
        return getCores()

          /**
           * Glossary:
           *  - 1 core = 1 block
           *  - 1 fork = 1 chain of cores
           *  - main fork = longest fork (if several, the one with highest hash)
           *  - main blockchain = confirmed blockchain + main fork
           */

          .then(function(cores){

            /**
             * 1. Check applicability
             *  - if no core exist: check block virtually against the blockchain
             *  - else if cores exist: check the block virtually against the core it is based upon
             *  - if OK (one core matches): create a core for this block
             */
            var basedCore = cores.length == 0 ? mainContext : getCore(cores, obj.number - 1, obj.previousHash);
            if (!basedCore) {
              throw 'Previous block not found';
            }
            return Q()
              .then(function(){
                if (doCheck) {
                  return basedCore.checkBlock(obj, constants.WITH_SIGNATURES_AND_POW);
                }
              })
              .then(function() {
                if (cores.length == 0 && forkWindowSize == 0) {
                  return mainContext.addBlock(obj, doCheck);
                } else {
                  return forkAndAddCore(basedCore, cores, obj)
                    .tap(function(){

                      /**
                       * 2. Shift
                       *  - take the highest core number
                       *  - if more than one core matches: stop Shift
                       *  - else if core number - blockchain current block number = FORK_WINDOW_SIZE then
                       *    * travel from highest core to its lowest core
                       *    * add lowest core's block to the blockchain
                       *    * delete this core
                       */
                      var maxNumber = _.max(cores, function(core) { return core.forkPointNumber; }).forkPointNumber;
                      var highestCores = _.where(cores, { forkPointNumber: maxNumber });
                      if (highestCores.length > 1) {
                        return false;
                      }
                      return mainDAL.getCurrentBlockOrNull()
                        .then(function(current){
                          return startPruning(highestCores[0], cores, current, forkWindowSize, doCheck);
                        });
                    });
                }
              });
          })
          .tap(function(){
            return Q.nfcall(that.stopPoWThenProcessAndRestartPoW.bind(that));
          })
          .then(resolve)
          .catch(reject)
          .finally(function() {
            blockIsProcessed();
          });
      });
    });
  };

  /**
   * Prune given branch until its size is less or equal to `forkWindowSize`, adding pruned blocks to main blokchain.
   * Resursively prune or delete other branches becoming uncompliant with main blockchain.
   * @param highest The highest core of the branch.
   * @param cores Cores managed by the node.
   * @param current Current block of main blockchain.
   * @param forkWindowSize Maximum size of the
   * @param doCheck
   * @returns {*}
   */
  function startPruning(highest, cores, current, forkWindowSize, doCheck) {
    var distanceFromMain = current && highest.forkPointNumber - current.number;
    var distanceFromVoid = highest.forkPointNumber + 1;
    var branchSize = distanceFromMain || distanceFromVoid;
    var toPruneCount = Math.max(0, branchSize - forkWindowSize);
    if (!toPruneCount) {
      // Fork window still has some room or is just full
      return Q();
    }
    // Fork window overflow, we have to prune some branches
    var currentTop = highest;
    var branch = [highest];
    var bottomNumber = currentTop.forkPointNumber - branchSize + 1;
    for (var i = currentTop.forkPointNumber; i > bottomNumber; i--) {
      currentTop = _.findWhere(cores, { forkPointNumber: currentTop.forkPointNumber - 1, forkPointHash: currentTop.forkPointPreviousHash });
      branch.push(currentTop);
    }
    branch = _.sortBy(branch, function(core) { return core.forkPointNumber; });
    branch = branch.slice(0, toPruneCount);
    // For each core to be pruned
    return branch.reduce(function(promise, core) {
      return promise
        .then(function(){
          return core.current()

            .then(function(currentOfCore){
              // Add the core to the main blockchain
              return mainContext.addBlock(currentOfCore, doCheck);
            })
            .then(function(){
              // Transfer the new identities
              return core.dal.listLocalPendingIdentities()
                .then(function(identities){
                  return Q.all(identities.map(function(idty) {
                    return mainContext.dal.savePendingIdentity(idty);
                  }));
                });
            })
            .then(function(){
              // Transfer pending certifications
              return core.dal.listLocalPendingCerts()
                .then(function(certs){
                  return Q.all(certs.map(function(cert) {
                    return mainContext.dal.registerNewCertification(cert);
                  }));
                });
            })
            .then(function(){
              // Transfer pending memberships
              return core.dal.listPendingLocalMemberships()
                .then(function(mss){
                  return Q.all(mss.map(function(ms) {
                    return mainContext.dal.savePendingMembership(ms);
                  }));
                });
            })
            .then(function(){
              // Transfer the peers
              return core.dal.listAllPeers()
                .then(function(peers){
                  return Q.all(peers.map(function(peer) {
                    return mainContext.dal.savePeer(peer);
                  }));
                });
            })

            // Remove the core from cores
            .then(function() {
              return mainDAL.unfork(core)
                .then(function(){
                  cores.splice(cores.indexOf(core), 1);
                  // A core was removed
                  return core;
                });
            })

            .tap(function(deleted){
              if (deleted) {
                /**
                 * 3. Prune
                 *   - if no core was deleted: stop Prune
                 *   - else
                 *     * Select all forks based on deleted core
                 *     * Delete these forks
                 */
                return pruneForks(deleted, cores);
              }
            })

            .tap(function(deleted){
              if (deleted) {
                /**
                 * 4. Bind cores previously bound to deleted core to mainDAL
                 */
                return bindUnboundsToMainDAL(deleted, cores);
              }
            });
        });
    }, Q());
  }

  function bindUnboundsToMainDAL(deleted, cores) {
    var unbounds = _.filter(cores, function(core) { return core.forkPointNumber == deleted.forkPointNumber + 1 && core.forkPointPreviousHash == deleted.forkPointHash; });
    unbounds.forEach(function(unbound) {
      unbound.dal.setRootDAL(mainDAL);
    });
    return Q();
  }

  function pruneForks(deleted, cores) {
    var orphans = _.filter(cores, function(core) { return core.forkPointNumber == deleted.forkPointNumber + 1 && core.forkPointPreviousHash != deleted.forkPointHash; });
    return Q.all(orphans.map(function(orphan) {
      cores = _.without(cores, orphan);
      return pruneForks(orphan, cores);
    }));
  }

  function forkAndAddCore(basedCore, cores, obj) {
    var coreObj = {
      forkPointNumber: parseInt(obj.number),
      forkPointHash: obj.hash,
      forkPointPreviousHash: obj.previousHash
    };
    return basedCore.dal.fork(obj)
      .then(function(coreDAL){
        that.currentDal = coreDAL;
        return blockchainCtx(conf, coreDAL);
      })
      .tap(function(ctx) {
        _.extend(ctx, coreObj);
      })
      .then(function(core){
        return core.addBlock(obj)
          .catch(function(err){
            throw err;
          })
          .tap(function(){
            return mainDAL.addCore(coreObj);
          })
          .then(function(block){
            cores.push(core);
            return block;
          });
      });
  }

  this.stopPoWThenProcessAndRestartPoW = function (done) {
    // If PoW computation process is waiting, trigger it
    if (computeNextCallback)
      computeNextCallback();
    if (conf.participate && !cancels.length && computing) {
      powFifo.push(function (taskDone) {
        cancels.push(taskDone);
      });
    }
    done();
  };

  function checkWoTConstraints (dal, sentries, block, newLinks, done) {
    if (block.number >= 0) {
      var newcomers = [];
      var ofMembers = [].concat(sentries);
      // other blocks may introduce unstability with new members
      async.waterfall([
        function (next) {
          block.joiners.forEach(function (inlineMS) {
            var fpr = inlineMS.split(':')[0];
            newcomers.push(fpr);
            ofMembers.push(fpr);
          });
          async.forEachSeries(newcomers, function (newcomer, newcomerTested) {
            async.waterfall([
              function (next) {
                if (block.number > 0)
                  mainContext.checkHaveEnoughLinks(newcomer, newLinks, next);
                else
                  next();
              },
              function (next) {
                // Check the newcomer IS RECOGNIZED BY the WoT
                // (check we have a path for each WoT member => newcomer)
                if (block.number > 0)
                  globalValidator(conf, blockchainDao(block, dal)).isOver3Hops(newcomer, ofMembers, newLinks, next);
                else
                  next(null, []);
              },
              function (outdistanced, next) {
                if (outdistanced.length > 0) {
                  // logger.debug('------ Newcomers ------');
                  // logger.debug(newcomers);
                  // logger.debug('------ Members ------');
                  // logger.debug(ofMembers);
                  // logger.debug('------ newLinks ------');
                  // logger.debug(newLinks);
                  // logger.debug('------ outdistanced ------');
                  // logger.debug(outdistanced);
                  logger.debug('Newcomer ' + newcomer + ' is not recognized by ' + JSON.stringify(outdistanced) + ' WoT for this block');
                  next('Newcomer ' + newcomer + ' is not recognized by the WoT for this block');
                }
                else next();
              }
            ], newcomerTested);
          }, next);
        }
      ], done);
    }
    else done('Cannot compute WoT constraint for negative block number');
  }

  function getSentryMembers(dal, members, done) {
    var sentries = [];
    async.forEachSeries(members, function (m, callback) {
      async.waterfall([
        function (next) {
          dal.getValidLinksFrom(m.pubkey).then(_.partial(next, null)).catch(next);
        },
        function (links, next) {
          // Only test agains members who make enough signatures
          if (links.length >= conf.sigWoT) {
            sentries.push(m.pubkey);
          }
          next();
        }
      ], callback);
    }, function(err) {
      done(err, sentries);
    });
  }

  /**
   * Generates root block with manual selection of root members.
   * @param done
   */
  this.generateManualRoot = function (done) {
    async.waterfall([
      function (next) {
        that.current(next);
      },
      function (block, next) {
        if (!block)
        that.generateNextBlock(new ManualRootGenerator(), next);
        else
          next('Cannot generate root block: it already exists.');
      }
    ], done);
  };

  function iteratedChecking(newcomers, checkWoTForNewcomers, done) {
    return Q.Promise(function(resolve){
      var passingNewcomers = [], hadError = false;
      async.forEachSeries(newcomers, function(newcomer, callback){
        checkWoTForNewcomers(passingNewcomers.concat(newcomer), function (err) {
          // If success, add this newcomer to the valid newcomers. Otherwise, reject him.
          if (!err) {
            passingNewcomers.push(newcomer);
          }
          hadError = hadError || err;
          callback();
        });
      }, function(){
        if (hadError) {
          // If at least one newcomer was rejected, test the whole new bunch
          resolve(iteratedChecking(passingNewcomers, checkWoTForNewcomers));
        }
        else {
          resolve(passingNewcomers);
        }
      });
    })
      .then(function(passingNewcomers) {
        done && done(null, passingNewcomers);
        return passingNewcomers;
      })
      .catch(done);
  }

  /**
   * Generates next block, finding newcomers, renewers, leavers, certs, transactions, etc.
   * @param done Callback.
   */
  this.generateNext = function (done) {
    return that.mainForkDAL()
      .catch(function(err) {
        done && done(err);
        throw err;
      })
      .then(function(dal){
        return that.generateNextBlock(dal, new NextBlockGenerator(conf, dal), done);
      });
  };

  /**
  * Generate next block, gathering both updates & newcomers
  */
  this.generateNextBlock = function (dal, generator, done) {
    return prepareNextBlock(dal)
      .spread(function(current, lastUDBlock, exclusions){
        return Q.all([
          generator.findNewCertsFromWoT(current),
          findNewcomersAndLeavers(dal, current, generator.filterJoiners),
          findTransactions(dal)
        ])
          .spread(function(newCertsFromWoT, newcomersLeavers, transactions) {
            var joinData = newcomersLeavers[2];
            var leaveData = newcomersLeavers[3];
            var newCertsFromNewcomers = newcomersLeavers[4];
            var certifiersOfNewcomers = _.uniq(_.keys(joinData).reduce(function(certifiers, newcomer) {
              return certifiers.concat(_.pluck(joinData[newcomer].certs, 'from'));
            }, []));
            var certifiers = [].concat(certifiersOfNewcomers);
            // Merges updates
            _(newCertsFromWoT).keys().forEach(function(certified){
              newCertsFromWoT[certified] = newCertsFromWoT[certified].filter(function(cert) {
                // Must not certify a newcomer, since it would mean multiple certifications at same time from one member
                var isCertifier = certifiers.indexOf(cert.from) != -1;
                if (!isCertifier) {
                  certifiers.push(cert.from);
                }
                return !isCertifier;
              });
            });
            _(newCertsFromNewcomers).keys().forEach(function(certified){
              newCertsFromWoT[certified] = (newCertsFromWoT[certified] || []).concat(newCertsFromNewcomers[certified]);
            });
            // Create the block
            return createBlock(dal, current, joinData, leaveData, newCertsFromWoT, exclusions, lastUDBlock, transactions);
          }, Q.reject);
      }, Q.reject)
      .then(function(block) {
        done && done(null, block);
        return block;
      })
      .catch(function(err) {
        if (!done) throw err;
        else done(err);
      });
  };

  /**
  * Generate next block, gathering both updates & newcomers
  */
  this.generateEmptyNextBlock = function (done) {
    return that.mainForkDAL()
      .then(function(dal){
        return prepareNextBlock(dal)
          .spread(function(current, lastUDBlock, exclusions){
            return createBlock(dal, current, {}, {}, {}, exclusions, lastUDBlock, [])
              .then(function(block){
                done && done(null, block);
                return block;
              });
          })
          .catch(done);
      });
  };

  function prepareNextBlock(dal) {
    return Q.all([
      dal.getCurrentBlockOrNull(),
      dal.lastUDBlock(),
      dal.getToBeKicked()
    ])
      .spread(function(current, lastUDBlock, exclusions) {
        return Q.all([
          current,
          lastUDBlock,
          _.pluck(exclusions, 'pubkey')
        ]);
      });
  }

  function findTransactions(dal) {
    return dal.getTransactionsPending()
      .then(function (txs) {
        var transactions = [];
        var passingTxs = [];
        var localValidation = localValidator(conf);
        var globalValidation = globalValidator(conf, blockchainDao(null, dal));
        return Q.Promise(function(resolve, reject){

          async.forEachSeries(txs, function (rawtx, callback) {
            var tx = new Transaction(rawtx, conf.currency);
            var extractedTX = tx.getTransaction();
            async.waterfall([
              function (next) {
                localValidation.checkBunchOfTransactions(passingTxs.concat(extractedTX), next);
              },
              function (next) {
                globalValidation.checkSingleTransaction(extractedTX, next);
              },
              function (next) {
                transactions.push(tx);
                passingTxs.push(extractedTX);
                next();
              }
            ], function (err) {
              if (err) {
                logger.error(err);
                dal.removeTxByHash(extractedTX.hash).then(_.partial(callback, null)).catch(callback);
              }
              else {
                logger.info('Transaction added to block');
                callback();
              }
            });
          }, function(err) {
            err ? reject(err) : resolve(transactions);
          });
        });
      });
  }

  function findNewcomersAndLeavers (dal, current, filteringFunc) {
    return Q.Promise(function(resolve, reject){
      async.parallel({
        newcomers: function(callback){
          findNewcomers(dal, current, filteringFunc, callback);
        },
        leavers: function(callback){
          findLeavers(dal, current, callback);
        }
      }, function(err, res) {
        var current = res.newcomers[0];
        var newWoTMembers = res.newcomers[1];
        var finalJoinData = res.newcomers[2];
        var updates = res.newcomers[3];
        err ? reject(err) : resolve([current, newWoTMembers, finalJoinData, res.leavers, updates]);
      });
    });
  }

  function findLeavers (dal, current, done) {
    var leaveData = {};
    async.waterfall([
      function (next){
        dal.findLeavers().then(_.partial(next, null)).catch(next);
      },
      function (mss, next){
        var leavers = [];
        mss.forEach(function (ms) {
          leavers.push(ms.issuer);
        });
        async.forEach(mss, function(ms, callback){
          var leave = { identity: null, ms: ms, key: null, idHash: '' };
          leave.idHash = (sha1(ms.userid + moment(ms.certts).unix() + ms.issuer) + "").toUpperCase();
          async.waterfall([
            function (next){
              async.parallel({
                block: function (callback) {
                  if (current) {
                    dal.getBlockOrNull(ms.number, function (err, basedBlock) {
                      callback(null, err ? null : basedBlock);
                    });
                  } else {
                    callback(null, {});
                  }
                },
                identity: function(callback){
                  dal.getIdentityByHashOrNull(leave.idHash, callback);
                }
              }, next);
            },
            function (res, next){
              if (res.identity && res.block && res.identity.currentMSN < leave.ms.number && res.identity.member) {
                // MS + matching cert are found
                leave.identity = res.identity;
                leaveData[res.identity.pubkey] = leave;
              }
              next();
            }
          ], callback);
        }, next);
      },
      function (next) {
        next(null, leaveData);
      }
    ], done);
  }

  function findNewcomers (dal, current, filteringFunc, done) {
    var wotMembers = [];
    var joinData = {};
    var updates = {};
    async.waterfall([
      function (next) {
        getPreJoinData(dal, current, next);
      },
      function (preJoinData, next){
        filteringFunc(preJoinData, next);
      },
      function (filteredJoinData, next) {
        joinData = filteredJoinData;
        // Cache the members
        dal.getMembers(next);
      },
      function (members, next) {
        getSentryMembers(dal, members, function(err, sentries) {
          next(err, members, sentries);
        });
      },
      function (members, sentries, next) {
        wotMembers = _.pluck(members, 'pubkey');
        // Checking step
        var newcomers = _(joinData).keys();
        var nextBlockNumber = current ? current.number + 1 : 0;
        // Checking algo is defined by 'checkingWoTFunc'
        iteratedChecking(newcomers, function (someNewcomers, onceChecked) {
          var nextBlock = {
            number: nextBlockNumber,
            joiners: someNewcomers
          };
          // Check WoT stability
          async.waterfall([
            function (next){
              computeNewLinks(nextBlockNumber, dal, someNewcomers, joinData, updates, next);
            },
            function (newLinks, next){
              checkWoTConstraints(dal, sentries, nextBlock, newLinks, next);
            }
          ], onceChecked);
        }, function (err, realNewcomers) {
          async.waterfall([
            function (next){
              computeNewLinks(nextBlockNumber, dal, realNewcomers, joinData, updates, next);
            },
            function (newLinks, next){
              var newWoT = wotMembers.concat(realNewcomers);
              next(err, realNewcomers, newLinks, newWoT);
            }
          ], next);
        });
      },
      function (realNewcomers, newLinks, newWoT, next) {
        var finalJoinData = {};
        realNewcomers.forEach(function(newcomer){
          // Only keep membership of selected newcomers
          finalJoinData[newcomer] = joinData[newcomer];
          // Only keep certifications from final members
          var keptCerts = [];
          joinData[newcomer].certs.forEach(function(cert){
            var issuer = cert.from;
            if (~newWoT.indexOf(issuer) && ~newLinks[cert.to].indexOf(issuer)) {
              keptCerts.push(cert);
            }
          });
          joinData[newcomer].certs = keptCerts;
        });
        // Send back the new WoT, the joining data and key updates for newcomers' signature of WoT
        next(null, current, wotMembers.concat(realNewcomers), finalJoinData, updates);
      }
    ], done);
  }

  function getPreJoinData(dal, current, done) {
    var preJoinData = {};
    async.waterfall([
      function (next){
        dal.findNewcomers().then(_.partial(next, null)).catch(next);
      },
      function (mss, next){
        var joiners = [];
        mss.forEach(function (ms) {
          joiners.push(ms.issuer);
        });
        async.forEach(mss, function(ms, callback){
          async.waterfall([
            function(nextOne) {
              if (current) {
                dal.getBlockOrNull(ms.number, nextOne);
              } else {
                nextOne(null, {});
              }
            },
            function(block, nextOne) {
              if (!block) {
                return nextOne('Block not found for membership');
              }
              var idtyHash = (sha1(ms.userid + moment(ms.certts).unix() + ms.issuer) + "").toUpperCase();
              getSinglePreJoinData(dal, current, idtyHash, nextOne, joiners);
            },
            function(join, nextOne) {
              join.ms = ms;
              if (join.identity.currentMSN < parseInt(join.ms.number)) {
                preJoinData[join.identity.pubkey] = join;
              }
              nextOne();
            }
          ], callback);
        }, next);
      }
    ], function(err) {
      done(err, preJoinData);
    });
  }

  this.requirementsOfIdentity = function(idty) {
    return Q.all([
      that.currentDal.getMembershipsForIssuer(idty.pubkey),
      that.currentDal.getCurrent(),
      that.currentDal.getMembers()
        .then(function(members){
          return Q.Promise(function(resolve, reject){
            getSentryMembers(that.currentDal, members, function(err, sentries) {
              if (err) return reject(err);
              resolve(sentries);
            });
          });
        })
    ])
      .spread(function(mss, current, sentries){
        var ms = _.chain(mss).where({ membership: 'IN' }).sortBy(function(ms) { return -ms.number; }).value()[0];
        return Q.nfcall(getSinglePreJoinData, that.currentDal, current, idty.hash)
          .then(function(join){
            join.ms = ms;
            var joinData = {};
            joinData[join.identity.pubkey] = join;
            return joinData;
          })
          .then(function(joinData){
            var pubkey = _.keys(joinData)[0];
            var join = joinData[pubkey];
            // Check WoT stability
            var someNewcomers = [join.identity.pubkey];
            var nextBlockNumber = current ? current.number + 1 : 0;
            return Q.nfcall(computeNewLinks, nextBlockNumber, that.currentDal, someNewcomers, joinData, {})
              .then(function(newLinks){
                return Q.all([
                  that.getValidCertsCount(pubkey, newLinks),
                  that.isOver3Hops(pubkey, newLinks, sentries, current)
                ])
                  .spread(function(certs, outdistanced) {
                    return {
                      uid: join.identity.uid,
                      meta: {
                        timestamp: parseInt(new Date(join.identity.time).getTime() / 1000)
                      },
                      outdistanced: outdistanced,
                      certifications: certs,
                      membershipMissing: !join.ms
                    };
                  });
              });
          });
      }, Q.reject);
  };

  this.getValidCertsCount = function(newcomer, newLinks) {
    return that.currentDal.getValidLinksTo(newcomer)
      .then(function(links){
        var count = links.length;
        if (newLinks && newLinks.length)
          count += newLinks.length;
        return count;
      });
  };

  this.isOver3Hops = function(newcomer, newLinks, sentries, current) {
    if (!current) {
      return Q([]);
    }
    return Q.Promise(function(resolve, reject){
      globalValidator(conf, blockchainDao(null, that.currentDal)).isOver3Hops(newcomer, sentries, newLinks, function(err, remainings) {
        if (err) return reject(err);
        resolve(remainings);
      });
    });
  };

  function getSinglePreJoinData(dal, current, idHash, done, joiners) {
    var join = { identity: null, key: null, idHash: idHash };
    async.waterfall([
      function (next){
        async.parallel({
          identity: function(callback){
            dal.getIdentityByHashOrNull(idHash, callback);
          },
          certs: function(callback){
            if (!current) {
              // Look for certifications from initial joiners
              // TODO: check if this is still working
              dal.certsNotLinkedToTarget(idHash)
                .then(function(certs){
                  callback(null, _.filter(certs, function(cert){
                    return ~joiners.indexOf(cert.from);
                  }));
                })
                .catch(callback);
            } else {
              // Look for certifications from WoT members
              dal.certsNotLinkedToTarget(idHash)
                .then(function(certs){
                  var finalCerts = [];
                  var certifiers = [];
                  async.forEachSeries(certs, function (cert, callback) {
                    async.waterfall([
                      function (next) {
                        if (!current && cert.block_number != 0) {
                          next('Number must be 0 for root block\'s certifications');
                        } else if (!current && cert.block_number == 0) {
                          next(null, { hash: 'DA39A3EE5E6B4B0D3255BFEF95601890AFD80709', medianTime: moment.utc().startOf('minute').unix() }); // Valid for root block
                        } else {
                          dal.getBlock(cert.block_number, function (err, basedBlock) {
                            next(err && 'Certification based on an unexisting block', basedBlock);
                          });
                        }
                      },
                      function (basedBlock, next){
                        async.parallel({
                          target: function (next) {
                            next(null, basedBlock);
                          },
                          current: function (next) {
                            if (!current)
                              next(null, null);
                            else
                              dal.getCurrent(next);
                          }
                        }, next);
                      },
                      function (res, next) {
                        if (res.current && res.current.medianTime > res.target.medianTime + conf.sigValidity) {
                          return next('Too old certification');
                        }
                        if (current) {
                          // Already exists a link not replayable yet?
                          dal.existsLinkFromOrAfterDate(cert.from, cert.to, current.medianTime - conf.sigDelay)
                            .then(function(exists) {
                              if (exists)
                                next('It already exists a similar certification written, which is not replayable yet');
                              else
                                dal.isMember(cert.from, next);
                            })
                            .catch(next);
                        }
                        else next(null, false);
                      },
                      function (isMember, next) {
                        var doubleSignature = ~certifiers.indexOf(cert.from) ? true : false;
                        if (isMember && !doubleSignature) {
                          certifiers.push(cert.from);
                          finalCerts.push(cert);
                        }
                        next();
                      }
                    ], function () {
                      callback();
                    });
                  }, function () {
                    callback(null, finalCerts);
                  });
                })
                .catch(callback);
            }
          }
        }, next);
      },
      function (res, next){
        if (res.identity) {
          // MS + matching cert are found
          join.identity = res.identity;
          join.certs = res.certs;
        }
        next(null, join);
      }
    ], done);
  }

  function computeNewLinks (forBlock, dal, theNewcomers, joinData, updates, done) {
    var newLinks = {}, certifiers = [];
    var certsByKey = _.mapObject(joinData, function(val){ return val.certs; });
    async.waterfall([
      function (next){
        async.forEach(theNewcomers, function(newcomer, callback){
          // New array of certifiers
          newLinks[newcomer] = newLinks[newcomer] || [];
          // Check wether each certification of the block is from valid newcomer/member
          async.forEach(certsByKey[newcomer], function(cert, callback){
            var isAlreadyCertifying = certifiers.indexOf(cert.from) !== -1;
            if (isAlreadyCertifying && forBlock > 0) {
              return callback();
            }
            if (~theNewcomers.indexOf(cert.from)) {
              // Newcomer to newcomer => valid link
              newLinks[newcomer].push(cert.from);
              certifiers.push(cert.from);
              callback();
            } else {
              async.waterfall([
                function (next){
                  dal.isMember(cert.from, next);
                },
                function (isMember, next){
                  // Member to newcomer => valid link
                  if (isMember) {
                    newLinks[newcomer].push(cert.from);
                    certifiers.push(cert.from);
                  }
                  next();
                }
              ], callback);
            }
          }, callback);
        }, next);
      },
      function (next){
        _.mapObject(updates, function(certs, pubkey) {
          newLinks[pubkey] = (newLinks[pubkey] || []).concat(_.pluck(certs, 'pubkey'));
        });
        next();
      }
    ], function (err) {
      done(err, newLinks);
    });
  }

  function createBlock (dal, current, joinData, leaveData, updates, exclusions, lastUDBlock, transactions) {
    // Prevent writing joins/updates for excluded members
    exclusions.forEach(function (excluded) {
      delete updates[excluded];
      delete joinData[excluded];
      delete leaveData[excluded];
    });
    _(leaveData).keys().forEach(function (leaver) {
      delete updates[leaver];
      delete joinData[leaver];
    });
    var block = new Block();
    block.version = 1;
    block.currency = current ? current.currency : conf.currency;
    block.number = current ? current.number + 1 : 0;
    block.parameters = block.number > 0 ? '' : [
      conf.c, conf.dt, conf.ud0,
      conf.sigDelay, conf.sigValidity,
      conf.sigQty, conf.sigWoT, conf.msValidity,
      conf.stepMax, conf.medianTimeBlocks, conf.avgGenTime, conf.dtDiffEval,
      conf.blocksRot, (conf.percentRot == 1 ? "1.0" : conf.percentRot)
    ].join(':');
    block.previousHash = current ? current.hash : "";
    block.previousIssuer = current ? current.issuer : "";
    if (selfPubkey)
      block.issuer = selfPubkey;
    // Members merkle
    var joiners = _(joinData).keys();
    var previousCount = current ? current.membersCount : 0;
    if (joiners.length == 0 && !current) {
      throw 'Wrong new block: cannot make a root block without members';
    }
    // Newcomers
    block.identities = [];
    // Newcomers + back people
    block.joiners = [];
    joiners.forEach(function(joiner){
      var data = joinData[joiner];
      // Identities only for never-have-been members
      if (!data.identity.member && !data.identity.wasMember) {
        block.identities.push(new Identity(data.identity).inline());
      }
      // Join only for non-members
      if (!data.identity.member) {
        block.joiners.push(new Membership(data.ms).inline());
      }
    });
    // Renewed
    block.actives = [];
    joiners.forEach(function(joiner){
      var data = joinData[joiner];
      // Join only for non-members
      if (data.identity.member) {
        block.actives.push(new Membership(data.ms).inline());
      }
    });
    // Leavers
    block.leavers = [];
    var leavers = _(leaveData).keys();
    leavers.forEach(function(leaver){
      var data = leaveData[leaver];
      // Join only for non-members
      if (data.identity.member) {
        block.leavers.push(new Membership(data.ms).inline());
      }
    });
    // Kicked people
    block.excluded = exclusions;
    // Final number of members
    block.membersCount = previousCount + block.joiners.length - block.excluded.length;

    //----- Certifications -----

    // Certifications from the WoT, to newcomers
    block.certifications = [];
    joiners.forEach(function(joiner){
      var data = joinData[joiner] || [];
      data.certs.forEach(function(cert){
        block.certifications.push(new Certification(cert).inline());
      });
    });
    // Certifications from the WoT, to the WoT
    _(updates).keys().forEach(function(certifiedMember){
      var certs = updates[certifiedMember] || [];
      certs.forEach(function(cert){
        block.certifications.push(new Certification(cert).inline());
      });
    });
    // Transactions
    block.transactions = [];
    transactions.forEach(function (tx) {
      block.transactions.push({ raw: tx.compact() });
    });
    return co(function *() {
      block.powMin = block.number == 0 ? 0 : yield globalValidator(conf, blockchainDao(block, dal)).getPoWMin(block.number);
      if (block.number == 0) {
        block.medianTime = moment.utc().unix() - conf.rootoffset;
      }
      else {
        block.medianTime = yield globalValidator(conf, blockchainDao(block, dal)).getMedianTime(block.number);
      }
      // Universal Dividend
      var lastUDTime = lastUDBlock && lastUDBlock.UDTime;
      if (!lastUDTime) {
        let rootBlock = yield dal.getBlockOrNull(0);
        lastUDTime = rootBlock && rootBlock.UDTime;
      }
      if (lastUDTime != null) {
        if (current && lastUDTime + conf.dt <= block.medianTime) {
          var M = current.monetaryMass || 0;
          var c = conf.c;
          var N = block.membersCount;
          var previousUD = lastUDBlock ? lastUDBlock.dividend : conf.ud0;
          block.dividend = Math.ceil(Math.max(previousUD, c * M / N));
        }
      }
      return block;
    });
  }

  var debug = process.execArgv.toString().indexOf('--debug') !== -1;
  if(debug) {
    //Set an unused port number.
    process.execArgv = [];
  }
  var powWorker;

  this.getPoWProcessStats = function(done) {
    if (powWorker)
      usage.lookup(powWorker.powProcess.pid, done);
    else
      done(null, { memory: 0, cpu: 0 });
  };

  var askedStop = null;

  this.stopProof = function(done) {
    if (!newKeyblockCallback) {
      askedStop = 'Stopping node.';
      newKeyblockCallback = function() {
        newKeyblockCallback = null;
        // Definitely kill the process for this BlockchainService instance
        if (powWorker) {
          powWorker.kill();
        }
        done();
      };
    }
    else done();
  };

  this.prove = function (block, sigFunc, nbZeros, done) {

    return Q.Promise(function(resolve){
      if (!powWorker) {
        powWorker = new Worker();
      }
      if (block.number == 0) {
        // On initial block, difficulty is the one given manually
        block.powMin = nbZeros;
      }
      // Start
      powWorker.setOnPoW(function(err, powBlock) {
        var theBlock = (powBlock && new Block(powBlock)) || null;
        resolve(theBlock);
        done && done(null, theBlock);
      });

      block.nonce = 0;
      powWorker.powProcess.send({ conf: conf, block: block, zeros: nbZeros,
        pair: {
          secretKeyEnc: base58.encode(pair.secretKey)
        }
      });
      logger.info('Generating proof-of-work of block #%s with %s leading zeros... (CPU usage set to %s%)', block.number, nbZeros, (conf.cpu*100).toFixed(0));
    });
  };

  function Worker() {

    var stopped = true;
    var that = this;
    var onPoWFound = function() { throw 'Proof-of-work found, but no listener is attached.'; };
    that.powProcess = childProcess.fork(path.join(__dirname, '/../lib/proof'));
    var start = null;
    var speedMesured = false;

    that.powProcess.on('message', function(msg) {
      var block = msg.block;
      if (stopped) {
        // Started...
        start = new Date();
        stopped = false;
      }
      if (!stopped && msg.found) {
        var end = new Date();
        var duration = (end.getTime() - start.getTime());
        var testsPerSecond = (1000/duration * msg.testsCount).toFixed(2);
        logger.debug('Done: %s in %ss (%s tests, ~%s tests/s)', msg.pow, (duration/1000).toFixed(2), msg.testsCount, testsPerSecond);
        stopped = true;
        start = null;
        onPoWFound(null, block);
      } else if (!stopped && msg.testsPerRound) {
        logger.info('Mesured max speed is ~%s tests/s. Proof will try with ~%s tests/s.', msg.testsPerSecond, msg.testsPerRound);
        speedMesured = true;
      } else if (!stopped && msg.nonce > block.nonce + constants.PROOF_OF_WORK.RELEASE_MEMORY) {
        // Reset fork process (release memory)...
        //logger.debug('Release mem... lastCount = %s, nonce = %s', block.nonce);
        block.nonce = msg.nonce;
        speedMesured = false;
        that.powProcess.kill();
        powWorker = new Worker();
        that.powProcess.send({ conf: conf, block: block, zeros: msg.nbZeros, pair: {
            secretKeyEnc: base58.encode(pair.secretKey)
          }
        });
      } else if (!stopped) {
        // Continue...
        //console.log('Already made: %s tests...', msg.nonce);
        // Look for incoming block
        if (speedMesured && cancels.length) {
          console.log(cancels);
          speedMesured = false;
          stopped = true;
          that.powProcess.kill();
          that.powProcess = null;
          powWorker = null;
          onPoWFound();
          logger.debug('Proof-of-work computation canceled.');
          start = null;
          var cancelConfirm = cancels.shift();
          cancelConfirm();
        }
      }
    });

    this.kill = function() {
      if (that.powProcess) {
        that.powProcess.kill();
        that.powProcess = null;
      }
    };

    this.setOnPoW = function(onPoW) {
      onPoWFound = onPoW;
    };
  }

  this.startGeneration = function () {
    return co(function *() {
      if (!conf.participate) {
        throw 'This node is configured for not participating to computing blocks.';
      }
      if (!selfPubkey) {
        throw 'No self pubkey found.';
      }
      askedStop = null;
      var block, current;
      var dal = yield that.mainForkDAL();
      var isMember = yield dal.isMember(selfPubkey);
      var powCanceled = '';
      if (!isMember) {
        powCanceled = 'Local node is not a member. Waiting to be a member before computing a block.';
      }
      else {
        current = yield dal.getCurrentBlockOrNull();
        if (!current) {
          powCanceled = 'Waiting for a root block before computing new blocks';
        }
        else {
          var lastIssuedByUs = current.issuer == selfPubkey;
          if (lastIssuedByUs) {
            logger.warn('Waiting ' + conf.powDelay + 's before starting computing next block...');
            yield Q.Promise(function(resolve){
              var timeoutToClear = setTimeout(function() {
                clearTimeout(timeoutToClear);
                computeNextCallback = null;
                resolve();
              }, (conf.powDelay || 1) * 1000);
              // Offer the possibility to break waiting
              computeNextCallback = function() {
                powCanceled = 'Waiting canceled.';
                clearTimeout(timeoutToClear);
                resolve();
              };
            });
            if (powCanceled) {
              logger.warn(powCanceled);
              return null;
            }
          }
          var trial = yield globalValidator(conf, blockchainDao(null, dal)).getTrialLevel(selfPubkey);
          if (trial > (current.powMin + 1)) {
            powCanceled = 'Too high difficulty: waiting for other members to write next block';
          }
          else {
            var block2 = lastGeneratedWasWrong ?
              yield that.generateEmptyNextBlock() :
              yield that.generateNext();
            var signature2 = signature.sync(pair);
            var trial2 = yield globalValidator(conf, blockchainDao(block2, dal)).getTrialLevel(selfPubkey);
            computing = true;
            return yield that.makeNextBlock(block2, signature2, trial2);
          }
        }
      }
      if (powCanceled) {
        logger.warn(powCanceled);
        return Q.Promise(function(resolve){
          computeNextCallback = resolve;
        });
      }
    })
      .then(function(block){
        computing = false;
        return block;
      });
  };

  this.makeNextBlock = function(block, sigFunc, trial, done) {
    return that.mainForkDAL()
      .then(function(dal){
        return Q.all([
          block ? Q(block) : that.generateNext(),
          sigFunc ? Q(sigFunc) : signature.sync(pair),
          trial ? Q(trial) : globalValidator(conf, blockchainDao(block, dal)).getTrialLevel(selfPubkey)
        ])
          .spread(function(unsignedBlock, sigF, trialLevel){
            return that.prove(unsignedBlock, sigF, trialLevel)
              .then(function(signedBlock){
                done && done(null, signedBlock);
                return signedBlock;
              })
              .catch(function(err){
                if (done) {
                  return done(err);
                }
                throw err;
              });
          }, Q.reject);
      });
  };

  this.recomputeTxRecords = function() {
    return that.mainForkDAL()
      .then(function(dal){
        return dal.dropTxRecords()
          .then(function(){
            return dal.getStat('tx');
          })
          .then(function(stat){
            return stat.blocks.reduce(function(p, number) {
              return p.then(function() {
                return dal.getBlockOrNull(number)
                  .then(function(block){
                    return dal.saveTxsInFiles(block.transactions, { block_number: block.number, time: block.medianTime });
                  });
              });
            }, Q());
          });
      });
  };

  this.addStatComputing = function () {
    var tests = {
      'newcomers': 'identities',
      'certs': 'certifications',
      'joiners': 'joiners',
      'actives': 'actives',
      'leavers': 'leavers',
      'excluded': 'excluded',
      'ud': 'dividend',
      'tx': 'transactions'
    };
    statQueue.push(function (sent) {
      //logger.debug('Computing stats...');
      async.forEachSeries(['newcomers', 'certs', 'joiners', 'actives', 'leavers', 'excluded', 'ud', 'tx'], function (statName, callback) {
        that.mainForkDAL()
          .then(function(forkDAL){
            async.waterfall([
              function (next) {
                async.parallel({
                  stat: function (next) {
                    forkDAL.getStat(statName).then(_.partial(next, null)).catch(next);
                  },
                  current: function (next) {
                    that.current(next);
                  }
                }, next);
              },
              function (res, next) {
                var stat = res.stat;
                var current = res.current;
                // Compute new stat
                async.forEachSeries(_.range(stat.lastParsedBlock + 1, (current ? current.number : -1) + 1), function (blockNumber, callback) {
                  // console.log('Stat', statName, ': tested block#' + blockNumber);
                  async.waterfall([
                    function (next) {
                      forkDAL.getBlockOrNull(blockNumber, next);
                    },
                    function (block, next) {
                      var testProperty = tests[statName];
                      var value = block[testProperty];
                      var isPositiveValue = value && typeof value != 'object';
                      var isNonEmptyArray = value && typeof value == 'object' && value.length > 0;
                      if (isPositiveValue || isNonEmptyArray) {
                        stat.blocks.push(blockNumber);
                      }
                      stat.lastParsedBlock = blockNumber;
                      next();
                    }
                  ], callback);
                }, function (err) {
                  next(err, stat);
                });
              },
              function (stat, next) {
                forkDAL.saveStat(stat, statName).then(_.partial(next, null)).catch(next);
              }
            ], callback);
          });
      }, function () {
        //logger.debug('Computing stats: done!');
        sent();
      });
    });
  };
  
  this.getCertificationsExludingBlock = function() {
    return that.currentDal.getCurrent()
      .then(function(current){
        return that.currentDal.getCertificationExcludingBlock(current, conf.sigValidity);
      })
      .catch(function(){
        return { number: -1 };
      });
  };
}

/**
 * Class to implement strategy of automatic selection of incoming data for next block.
 * @constructor
 */
function NextBlockGenerator(conf, dal) {

  this.findNewCertsFromWoT = function(current) {
    return Q.Promise(function(resolve, reject){
      var updates = {};
      var updatesToFrom = {};
      async.waterfall([
        function (next) {
          dal.certsFindNew()
            .then(function(dd){
              next(null, dd);
            })
            .catch(function(err){
              next(err);
            });
        },
        function (certs, next){
          async.forEachSeries(certs, function(cert, callback){
            async.waterfall([
              function (next) {
                if (current) {
                  // Already exists a link not replayable yet?
                  dal.existsLinkFromOrAfterDate(cert.from, cert.to, current.medianTime - conf.sigDelay)
                    .then(function(exists) {
                      next(null, exists);
                    })
                    .catch(next);
                }
                else next(null, false);
              },
              function (exists, next) {
                if (exists)
                  next('It already exists a similar certification written, which is not replayable yet');
                else {
                  // Signatory must be a member
                  dal.isMemberOrError(cert.from, next);
                }
              },
              function (next){
                // Certified must be a member and non-leaver
                dal.isMembeAndNonLeaverOrError(cert.to, next);
              },
              function (next){
                updatesToFrom[cert.to] = updatesToFrom[cert.to] || [];
                updates[cert.to] = updates[cert.to] || [];
                if (updatesToFrom[cert.to].indexOf(cert.from) == -1) {
                  updates[cert.to].push(cert);
                  updatesToFrom[cert.to].push(cert.from);
                }
                next();
              }
            ], function () {
              callback();
            });
          }, next);
        }
      ], function (err) {
        err ? reject(err) : resolve(updates);
      });
    });
  };

  this.filterJoiners = function takeAllJoiners(preJoinData, done) {
    var validator = globalValidator(conf, blockchainDao(dal));
    // No manual filtering, takes all BUT already used UID or pubkey
    var filtered = {};
    async.forEach(_.keys(preJoinData), function(pubkey, callback) {
      async.waterfall([
        function(next) {
          validator.checkExistsUserID(preJoinData[pubkey].identity.uid, next);
        },
        function(exists, next) {
          if (exists && !preJoinData[pubkey].identity.wasMember) {
            return next('UID already taken');
          }
          validator.checkExistsPubkey(pubkey, next);
        },
        function(exists, next) {
          if (exists && !preJoinData[pubkey].identity.wasMember) {
            return next('Pubkey already taken');
          }
          next();
        }
      ], function(err) {
        if (!err) {
          filtered[pubkey] = preJoinData[pubkey];
        }
        callback();
      });
    }, function(err) {
      done(err, filtered);
    });
  };
}

/**
 * Class to implement strategy of manual selection of root members for root block.
 * @constructor
 */
function ManualRootGenerator() {

  this.findNewCertsFromWoT = function() {
    return Q({});
  };

  this.filterJoiners = function(preJoinData, next) {
    var joinData = {};
    var newcomers = _(preJoinData).keys();
    var uids = [];
    newcomers.forEach(function(newcomer){
      uids.push(preJoinData[newcomer].ms.userid);
    });
    if (newcomers.length > 0) {
      inquirer.prompt([{
        type: "checkbox",
        name: "uids",
        message: "Newcomers to add",
        choices: uids,
        default: uids[0]
      }], function (answers) {
        newcomers.forEach(function(newcomer){
          if (~answers.uids.indexOf(preJoinData[newcomer].ms.userid))
            joinData[newcomer] = preJoinData[newcomer];
        });
        if (answers.uids.length == 0)
          next('No newcomer selected');
        else
          next(null, joinData);
      });
    } else {
      next('No newcomer found');
    }
  };
}
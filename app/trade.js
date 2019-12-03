const TradeOfferManager = require('steam-tradeoffer-manager');

const community = require('lib/community');

const handlerManager = require('app/handler-manager');

const communityLoginCallback = require('utils/communityLoginCallback');

const receivedOffers = [];
const itemsInTrade = [];

let processingOffer = false;

/**
 * This function is called when polldata is emitted by the manager
 * @param {Object} pollData
 */
exports.onPollData = function (pollData) {
    // Remove data from old offers

    const current = Math.round(new Date().getTime() / 1000);
    const max = 3600;

    for (const id in pollData.timestamps) {
        if (!Object.prototype.hasOwnProperty.call(pollData.timestamps, id)) {
            continue;
        }

        const time = pollData.timestamps[id];
        let state;

        if (pollData.sent[id] !== undefined) {
            state = pollData.sent[id];
        } else if (pollData.received[id] !== undefined) {
            state = pollData.received[id];
        }

        const isActive = state === TradeOfferManager.ETradeOfferState.Accepted || state === TradeOfferManager.ETradeOfferState.CreatedNeedsConfirmation || state === TradeOfferManager.ETradeOfferState.InEscrow;

        if (!isActive && current - time > max) {
            // FIXME: All these checks are not really nessesary
            if (pollData.offerData !== undefined && pollData.offerData[id]) {
                delete pollData.offerData[id];
            }
            if (pollData.timestamps[id]) {
                delete pollData.timestamps[id];
            }
        }
    }

    handlerManager.getHandler().onPollData(pollData);
};

exports.setPollData = function (pollData) {
    // Go through sent and received offers

    const activeOrCreatedNeedsConfirmation = [];

    for (const id in pollData.sent) {
        if (!Object.prototype.hasOwnProperty.call(pollData.sent, id)) {
            continue;
        }

        const state = pollData.sent[id];

        if (state === TradeOfferManager.ETradeOfferState.Active || state === TradeOfferManager.EConfirmationMethod.CreatedNeedsConfirmation) {
            activeOrCreatedNeedsConfirmation.push(id);
        }
    }

    for (const id in pollData.received) {
        if (!Object.prototype.hasOwnProperty.call(pollData.received, id)) {
            continue;
        }

        const state = pollData.received[id];

        if (state === TradeOfferManager.ETradeOfferState.Active) {
            activeOrCreatedNeedsConfirmation.push(id);
        }
    }

    // Go through all sent / received offers and mark the items as in trade
    for (let i = 0; i < activeOrCreatedNeedsConfirmation.length; i++) {
        const id = activeOrCreatedNeedsConfirmation[i];

        const offerData = pollData.offerData === undefined ? {} : (pollData.offerData[id] || {});
        const assetids = offerData.assetids || [];

        for (let i = 0; i < assetids.length; i++) {
            exports.setItemInTrade(assetids[i]);
        }
    }

    require('lib/manager').pollData = pollData;
};

/**
 * Called when the state of an offer changes
 * @param {Object} offer
 * @param {Number} oldState
 */
exports.offerChanged = function (offer, oldState) {
    const inventoryManager = require('app/inventory');

    if (offer.state === TradeOfferManager.ETradeOfferState.Active || offer.state === TradeOfferManager.ETradeOfferState.CreatedNeedsConfirmation) {
        // Offer is active / made, items are in trade
        offer.itemsToGive.forEach(function (item) {
            exports.setItemInTrade(item.id);
        });

        if (offer.data('assetids') === null) {
            offer.data('assetids', offer.itemsToGive.map((item) => item.assetid));
        }
    } else {
        // Remove items from list of items we are offering
        offer.itemsToGive.forEach(function (item) {
            exports.unsetItemInTrade(item.id);
        });
    }

    if (offer.state !== TradeOfferManager.ETradeOfferState.Accepted) {
        handlerManager.getHandler().onTradeOfferUpdated(offer, oldState);
        return;
    }

    // Offer is accepted, update inventory
    if (offer.itemsToGive.length !== 0) {
        // Remove lost items from inventory
        offer.itemsToGive.forEach(function (item) {
            inventoryManager.removeItem(item.assetid);
        });
    }

    // Fetch inventory to get received items
    inventoryManager.getInventory(community.steamID, function () {
        handlerManager.getHandler().onTradeOfferUpdated(offer, oldState);
    });
};

/**
 * Called when a new offer is received
 * @param {Object} offer
 */
exports.newOffer = function (offer) {
    if (offer.isGlitched()) {
        // The offer is glitched, skip it
        return;
    }

    // Offer is active, items are in trade
    offer.itemsToGive.forEach(function (item) {
        exports.setItemInTrade(item.id);
    });

    // Enqueue the offer
    enqueueOffer(offer);
};

/**
 * Get items that are being traded
 * @return {Array<String>}
 */
exports.inTrade = function () {
    return itemsInTrade;
};

/**
 * Removes an item from the items in trade list
 * @param {String} assetid
 */
exports.unsetItemInTrade = function (assetid) {
    const index = itemsInTrade.indexOf(assetid);

    if (index !== -1) {
        itemsInTrade.splice(index, 1);
    }
};

/**
 * Adds an item to the items in trade list
 * @param {String} assetid
 */
exports.setItemInTrade = function (assetid) {
    const index = itemsInTrade.indexOf(assetid);

    if (index === -1) {
        itemsInTrade.push(assetid);
    }
};

/**
 * Enqueues a new offer
 * @param {Object} offer
 */
function enqueueOffer (offer) {
    if (receivedOffers.indexOf(offer.id) === -1) {
        receivedOffers.push(offer.id);

        if (receivedOffers.length === 1) {
            // Queue is empty, check the offer right away
            processingOffer = true;
            handlerProcessOffer(offer);
        } else {
            processNextOffer();
        }
    }
}

/**
 * Sends an offer and handles errors
 * @param {Object} offer
 * @param {Function} callback
 */
exports.sendOffer = function (offer, callback) {
    if (callback === undefined) {
        callback = noop;
    }

    const ourAssetids = [];

    offer.itemsToGive.forEach(function (item) {
        exports.setItemInTrade(item.assetid);
        ourAssetids.push(item.assetid);
    });

    offer.data('assetids', ourAssetids);

    // FIXME: Fix problem with not accepting mobile confirmation for offers if steam returns an error

    sendOfferRetry(offer, function (err, status) {
        if (err) {
            // TODO: On eresult 16 then make the bot wait a few seconds and check if the trade was made, then accept mobile confirmation

            // Failed to send the offer, the items are no longer in trade
            offer.itemsToGive.forEach(function (item) {
                exports.unsetItemInTrade(item.id);
            });
            return callback(err);
        }

        if (status === 'pending') {
            offer.data('actedOnConfirmation', true);
            acceptConfirmation(offer.id);
        }

        callback(null, status);
    });
};

function sendOfferRetry (offer, callback, tries = 0) {
    offer.send(function (err, status) {
        offer.data('handledByUs', true);

        tries++;
        if (err) {
            if (tries >= 5) {
                return callback(err);
            }

            if (err.message.indexOf('can only be sent to friends') !== -1) {
                return callback(err);
            } else if (err.message.indexOf('is not available to trade')) {
                return callback(err);
            } else if (err.message.indexOf('maximum number of items allowed in your Team Fortress 2 inventory') !== -1) {
                return callback(err);
            } else if (err.eresult !== undefined) {
                if (err.eresult == 26) {
                    // One or more of the items does not exist in the inventories, refresh our inventory and return the error
                    require('app/inventory').getInventory(community.steamID, function () {
                        callback(err);
                    });
                } else {
                    return callback(err);
                }
            }

            if (err.message !== 'Not Logged In') {
                setTimeout(function () {
                    acceptOfferRetry(offer, callback, tries);
                }, 5000 * tries);
                return;
            }

            communityLoginCallback(true, function (err) {
                setTimeout(function () {
                    acceptOfferRetry(offer, callback, tries);
                }, err !== null ? 5000 * tries : 0);
            });
            return;
        }

        callback(null, status);
    });
}

exports.acceptOffer = function (offer, callback) {
    if (callback === undefined) {
        callback = noop;
    }

    acceptOfferRetry(offer, function (err, status) {
        if (err) {
            return callback(err);
        }

        if (status === 'pending') {
            acceptConfirmation(offer.id);
            offer.data('actedOnConfirmation', true);
        }

        callback(null, status);
    });
};

/**
 * Accepts a confirmation
 * @param {String} objectID
 * @param {Function} callback
 */
function acceptConfirmation (objectID, callback) {
    if (callback === undefined) {
        callback = noop;
    }

    // TODO: Add retrying / error handling

    community.acceptConfirmationForObject(process.env.STEAM_IDENTITY_SECRET, objectID, callback);
}

function acceptOfferRetry (offer, callback, tries = 0) {
    // true - skip state update used to check if a trade is being held
    offer.accept(true, function (err, status) {
        offer.data('handledByUs', true);

        tries++;
        if (err) {
            if (tries >= 5) {
                return callback(err);
            }

            if (err.message !== 'Not Logged In') {
                setTimeout(function () {
                    acceptOfferRetry(offer, callback, tries);
                }, 5000 * tries);
                return;
            }

            communityLoginCallback(true, function (err) {
                setTimeout(function () {
                    acceptOfferRetry(offer, callback, tries);
                }, err !== null ? 5000 * tries : 0);
            });
            return;
        }

        callback(null, status);
    });
}

exports.declineOffer = function (offer, callback) {
    if (callback === undefined) {
        callback = noop;
    }

    // TODO: Add error handling
    offer.decline(function (err) {
        offer.data('handledByUs', true);
        callback(err);
    });
};

/**
 * Processes a new offer, can only process one at a time
 */
function processNextOffer () {
    if (processingOffer || receivedOffers.length === 0) {
        return;
    }

    processingOffer = true;

    const offerId = receivedOffers[0];

    getOfferRetry(offerId, function (err, offer) {
        if (err) {
            // After many retries we could not get the offer data

            if (receivedOffers.length !== 1) {
                // Remove the offer from the queue and add it to the back of the queue
                receivedOffers.push(offerId);
            }

            handlerManager.getHandler().onTradeFetchError(offerId, err);
        }

        if (!offer) {
            finishedProcessing();
        } else {
            handlerProcessOffer(offer);
        }
    });
}

function handlerProcessOffer (offer) {
    handlerManager.getHandler().onNewTradeOffer(offer, function (action) {
        if (action === 'accept') {
            exports.acceptOffer(offer, function (err) {
                if (err) {
                    handlerManager.getHandler().onTradeAcceptError(offer.id, err);
                }

                finishedProcessing(offer);
            });
        } else if (action === 'decline') {
            exports.declineOffer(offer, function (err) {
                if (err) {
                    handlerManager.getHandler().onTradeDeclineError(offer.id, err);
                }

                finishedProcessing(offer);
            });
        } else {
            finishedProcessing(offer);
        }
    });
}

function finishedProcessing (offer) {
    removeFromQueue(offer.id);
    processingOffer = false;
    processNextOffer();
}

/**
 * Gets an offer
 * @param {String} offerId
 * @param {Function} callback
 * @param {Number} tries
 */
function getOfferRetry (offerId, callback, tries = 0) {
    require('lib/manager').getOffer(offerId, function (err, offer) {
        tries++;

        if (err) {
            if (err.message === 'NoMatch' || err.message === 'No matching offer found') {
                // The offer does not exist
                return callback(null, null);
            }

            if (tries >= 5) {
                // Too many retries
                return callback(err);
            }

            if (err.message !== 'Not Logged In') {
                setTimeout(function () {
                    getOfferRetry(offerId, callback, tries);
                }, 5000 * tries);
                return;
            }

            // Our session has expired, we will wait for it to change and then retry

            // Because we have given the manager our community instance, it will be notified and the sessionExpired event will be emitted, which will result in a new session to be made
            communityLoginCallback(true, function (err) {
                setTimeout(function () {
                    getOfferRetry(offerId, callback, tries);
                }, err !== null ? 5000 * tries : 0);
            });
            return;
        }

        if (offer.state !== TradeOfferManager.ETradeOfferState.Active) {
            return callback(null, null);
        }

        callback(null, offer);
    });
}

/**
 * Removes an offer from the queue
 * @param {String} offerId
 */
function removeFromQueue (offerId) {
    const index = receivedOffers.indexOf(offerId);

    if (index !== -1) {
        receivedOffers.splice(index, 1);
    }
}

function noop () {

}

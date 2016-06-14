var bitcoin = require('bitcoinjs-lib');
var paychanlib = require('./paychanlib');

module.exports = {
    PaymentChannel: PaymentChannel,
    blockchainAddrInfo: blockchain_getAddressInfo
};


// var network = bitcoin.networks.testnet;


function PaymentChannel(serverAddress, keyPair, expTime) {
    this._serverEndpoint = serverAddress;
    this._keyPair = keyPair;
    this._expTime = expTime;

    this.getFundingAddress = function (gotFundingAddressCallback) {
        getJSON(this._serverEndpoint + "/fundingInfo" +
            "?client_pubkey=" + paychanlib.util.hexFromPubKey(this._keyPair) +
            "&exp_time=" + this._expTime,
            this._handleFundInfoRes.bind(this, gotFundingAddressCallback)
        );
    };

    this.getRefundTx = function() { return jsendError("Please 'setFundingSource' first") };

    this._fundingSource = null;

    this.setFundingSource = function(txid, outputIndex, value) {
        this._fundingSource.txid = txid;
        this._fundingSource.vout = outputIndex;
        this._fundingSource.value = value;

        this.getRefundTx = createRefundTx.bind(undefined,
            this._keyPair,
            txid,
            outputIndex,
            this._channelInfo.redeemScript,
            this._expTime,
            value
        );
    };

    this.openChannel = function(changeAddress) {
        if (this._fundingSource === null) {
            return jsendError("Please use 'setFundingSource' to add information about the funding transaction")
        }

        var payConn = new PayChanConnection(
            this._keyPair,
            this._fundingSource.txid,
            this._fundingSource.vout,
            this._fundingSource.value,
            this._channelInfo.redeemScript,
            changeAddress );

        payConn.connect();

    };

    this._handleFundInfoRes = function (fundingInfoResponseCallback, fundInfo, res) {
        if (res.statusCode != 200) {
            fundingInfoResponseCallback(new Error(res.statusMessage));
        } else {
            // Verify response format {-
            var fi = fundInfo;
            if ((fi.server_pubkey === undefined) || (fi.funding_address_copy === undefined) ||
                (fi.settlement_period_hours === undefined) || (fi.funding_tx_min_conf === undefined) ||
                (fi.open_price === undefined)) {
                fundingInfoResponseCallback(new Error("Invalid server response: " + fi));
                return;
            }
            // -}

            //DEBUG
            console.log(fi);
            var serverPubKey = paychanlib.util.pubKeyFromHex(fi.server_pubkey);
            var fundingAddress = paychanlib.deriveFundingAddress(
                this._keyPair,
                serverPubKey,
                this._expTime);

            if (fundingAddress === fi.funding_address_copy) {
                this._channelInfo = {
                    fundingAddress: fundingAddress,
                    redeemScript: paychanlib.util.channelRedeemScript(
                        this._keyPair,
                        serverPubKey,
                        this._expTime),
                    serverPubKey: fi.server_pubkey,
                    settlementPeriod: fi.settlement_period_hours,
                    fundingConfirmations: fi.funding_tx_min_conf,
                    openPrice: fi.open_price,
                    openURL: res.headers.location
                };

                fundingInfoResponseCallback(
                    null, // no error
                    fundingAddress);
            } else {
                fundingInfoResponseCallback(
                    new Error("BUG! Server's calculated funding address doesn't match ours.")
                );
            }
        }
    };
}

// ----REST-----
function doItAll(endpoint, keyPair, expTime) {
    getJSON(endpoint + "/fundingInfo" +
        "?client_pubkey=" + hexFromPubKey(keyPair) +
        "&exp_time=" + expTime,
        openChannel);
}


function gotAddressInfo(redeemScript, openURL, openPrice, fundInfo) {
    var fi = fundInfo;
    if  ((fi.transaction_hash === undefined) ||
        (fi.output_index === undefined) ||
        (fi.amount === undefined)) {
            console.log("Error: Blockchain API didn't return the requested information:");
            console.log(fi);
            return;
    }

    // Initialize channel state object
    var changeAddress = clientKeyPair.getAddress();
    var state = new PayChanConnection(
        clientKeyPair,
        fi.transaction_hash,
        fi.output_index,
        fundInfo.amount,
        redeemScript,
        expTime,
        changeAddress // TODO
    );

    var initPayment = state._createPaymentOfValue(openPrice);

    postWithPaymentPayload(
        openURL + "&change_address=" + changeAddress,
        initPayment.toString('base64'),
        storeChannel.bind(undefined, state)
    );
}

function storeChannel(state, response, data) {
    state._setChannelURL(response.headers.location);
    console.log("Got open response:");
    console.log(data);

    loopPayment(state);

    //DEBUG
    window.res = response;
}

function loopPayment(state, res, data) {
    var amount = 20000;

    if (state._changeVal >= amount) {
        console.log("Making payment...");
        state.makePayment(amount, loopPayment.bind(undefined, state));
    } else {

        console.log(state);
        state.deleteChannel(function (res,data) {
            console.log("Got delete channel response: " + res.statusCode + " " + res.statusMessage);
        });
        console.log("Done!");
    }
}

// ----REST-----


// ---- State + Library + REST -----
/**
 * Payment channel connection state object .
 * Create and send payments to a payment channel server endpoint.
 *
 * @constructor
 */
function PayChanConnection(clientKeyPair, funding_txid, funding_vout, chanValue, redeemScript, changeAddress) {
    this._changeVal = chanValue;

    this.connect = function(url, openPrice) {
        var initPayment = this._createPaymentOfValue(openPrice);

        postWithPaymentPayload(
            url + "&change_address=" + changeAddress,
            initPayment.toString('base64'),
            this._handleOpenResponse
        );
    };

    this._handleOpenResponse = function (response, data) {
        state._setChannelURL(response.headers.location);
        console.log("Got open response data:");
        console.log(data);
        console.log(response);

        // this._registerSuccessfulPayment


    };

    this._registerSuccessfulPayment = function(payment, val) {
        this._changeVal -= val;
        this._storeLastPayment(payment);
    };

    this._createPayment = createPayment.bind(undefined,
        clientKeyPair,
        funding_txid,
        funding_vout,
        redeemScript,
        changeAddress);

    this._createPaymentOfValue = function (val) {
        return this._createPayment(this._changeVal - val);
    };

    this.makePayment = function(val, callback) {
        var handlePayment = this._handlePaymentResponse.bind(this);
        var paymentPayload = this._createPaymentOfValue(val).toString('base64');
        if (this._channelURL != undefined) {
            putWithPaymentPayload(
                this._channelURL, // "&change_address=" + changeAddress,
                paymentPayload,
                function (res,data) {
                    handlePayment(paymentPayload, val, res, data);
                    callback(res,data);
                });
        } else {
            return new Error("PayChanConnection is uninitialized")
        }
    };

    this._getLastPayment = function() {
        if (this._lastPaymentPayload != undefined) {
            return this._lastPaymentPayload;
        } else {
            return new Error("can't fetch last payment; no payments sent yet")
        }

    };

    this._handlePaymentResponse = function(paymentPayload, paymentValue,res,data) {
        this._changeVal -= paymentValue;
        // Store payment
        console.log(this._storeLastPayment);
        this._storeLastPayment(paymentPayload);
        console.log(this._lastPaymentPayload);
        console.log("Got makePayment() response:");
        console.log(data);
    };

    this.deleteChannel = function(callback) {
        if (this._channelURL != undefined) {
            deleteWithPaymentPayload(
                this._channelURL,
                this._getLastPayment(),
                callback
            );
        } else {
            return new Error("no channel open yet")
        }
    };

    this._setChannelURL = function (url) {
        this._channelURL = url;
    };

    this._storeLastPayment = function(paymentPayload) {
        this._lastPaymentPayload = paymentPayload;
    };
}










// ---- HTTP -----
var Client = require('node-rest-client').Client;
var http = new Client();

var getJSON = http.get;

/**
 * Perform an HTTP request with the payment payload added as a "payment"
 * query string paramter.
 * */
function withPaymentPayload (method, theURL, payPayload, args, success) {
    theURL = theURL + "?payment=" + payPayload;
    method(theURL, {}, function (data, response) {
        success(response,data);
    });
}

var postWithPaymentPayload = withPaymentPayload.bind(undefined, http.post);
var putWithPaymentPayload = withPaymentPayload.bind(undefined, http.put);
var deleteWithPaymentPayload = withPaymentPayload.bind(undefined, http.delete);

// ---- HTTP -----


// ---- jsend JSON ---{

function jsendError(msg) {
    return { status: "error",
        message: msg }
}

function jsendWrap(res) {
    return { status: "success",
        data: res }
}

// ---- jsend JSON ---}


// -----Blockchain API-----

function blockchain_getAddressInfo(fundingAddress, callback) {
    http.get("https://testnet3.toshi.io/api/v0/addresses/" + fundingAddress + "/unspent_outputs",
        function (jsonArray, response) {
            if (response.statusCode === 404) {
                callback( jsendError("Blockchain API: Found no transactions paying to " + fundingAddress) );
            } else if (response.statusCode != 200) {
                callback( jsendError("Blockchain API: Unknown error: " + response) );
            } else {
                var fi = jsonArray.last(); // last item = first tx paying to address

                if ((fi.transaction_hash === undefined) ||
                    (fi.output_index === undefined) ||
                    (fi.amount === undefined)) {
                    callback( jsendError("Error: Blockchain API didn't return the requested information: " + fi) );
                } else {
                    callback(jsendWrap(fi));
                }
            }
        }
    );
}

if (!Array.prototype.last){
    Array.prototype.last = function(){
        return this[this.length - 1];
    };
}

// /unspent_outputs:
// No funds received (no unconfirmed): 404
// No funds received (unconfirmed): 404

// Funds received, by redeemed: []


// https://testnet3.toshi.io/api/v0/addresses/2NGLjHFmJtcg1ECbtuCJ7xafYcv2fWzq5tP
// ==========================
// With no payment: 404
// {"error":"Not Found"}
// ------
// With unconfirmed payment: 200
// {
//     "hash":"2NGLjHFmJtcg1ECbtuCJ7xafYcv2fWzq5tP",
//     "balance":0,
//     "received":0,
//     "sent":0,
//     "unconfirmed_received":100000,
//     "unconfirmed_sent":0,
//     "unconfirmed_balance":100000
// }
// With confirmed payment: 200
// {
//     "hash":"2NGLjHFmJtcg1ECbtuCJ7xafYcv2fWzq5tP",
//     "balance":100000,
//     "received":100000,
//     "sent":0,
//     "unconfirmed_received":0,
//     "unconfirmed_sent":0,
//     "unconfirmed_balance":0
// }



// -----Blockchain API-----




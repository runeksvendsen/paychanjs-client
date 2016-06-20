// var bitcoin = require('bitcoinjs-lib');
var paychanlib = require('./paychanlib');


function PaymentChannel(serverAddress, keyPair, expTime, changeAddress, network) {
    var networkStr = (network.pubKeyHash === 0x00) ? "live" : "test";
    this.config = {
        _serverEndpoint: serverAddress,
        _keyPair: keyPair,
        _expTime: expTime,
        _changeAddress: changeAddress,
        
        _network: network,
        _networkStr: networkStr,
        _basePath: "/v1/" + networkStr
    };
    this.state = {
        _fundingSource: {empty: true},
        _serverInfo: {}
    };

    this.getOpenPrice = function () {
        var price = this.state._serverInfo.openPrice;
        if (price === undefined) {
            this.getFundingAddress();
        }
        return price;
    };


    this.getFundingAddress = function (gotFundingAddressCallback) {
        getJSON(this.config._serverEndpoint + this.config._basePath + "/fundingInfo" +
            "?client_pubkey=" + paychanlib.util.hexFromPubKey(this.config._keyPair) +
            "&exp_time=" + this.config._expTime,
            this._handleFundInfoRes.bind(this, gotFundingAddressCallback)
        );
    };

    this._handleFundInfoRes = function (fundingInfoResponseCallback, fi, res) {
        if (res.statusCode != 200) {
            fundingInfoResponseCallback(res.statusMessage);
        } else {
            var isResponseValid = fi.server_pubkey || fi.funding_address_copy ||
                fi.settlement_period_hours || fi.funding_tx_min_conf || fi.open_price || "nope";

            if (isResponseValid === "nope") {
                fundingInfoResponseCallback("Invalid server response: " + fi);
            } else {
                var serverPubKey = paychanlib.util.pubKeyFromHex(fi.server_pubkey);
                var fundingAddress = paychanlib.deriveFundingAddress(
                    this.config._keyPair,
                    serverPubKey,
                    this.config._expTime,
                    this.config._network);

                if (fundingAddress === fi.funding_address_copy) {
                    this.state._serverInfo.fundingInfo = fi;
                    this.state._serverInfo.pubKey = serverPubKey;
                    this.state._serverInfo.openURL = res.headers.location;
                    this.state._serverInfo.openPrice = fi.open_price;


                    fundingInfoResponseCallback(
                        null, // success! (error = null)
                        fundingAddress,
                        fi);
                } else {
                    fundingInfoResponseCallback(
                        "BUG! Server's calculated funding address doesn't match ours."
                    );
                }
            }
        }
    };
    

    /**
     * Specify attributes of the transaction output which funds the channel:
     *      txid of transaction, output index, output value
     * */
    this.setFundingSource = function(txid, outputIndex, value) {
        this.state._fundingSource.empty = false;
        this.state._fundingSource.txid = txid;
        this.state._fundingSource.vout = outputIndex;
        this.state._fundingSource.value = value;

        this._setupRefundTxGetter()
    };

    this._setupRefundTxGetter = function() {
        this.state._redeemScript = paychanlib.util.channelRedeemScript(
            this.config._keyPair,
            this.state._serverInfo.pubKey,
            this.config._expTime);

        this.getRefundTx = function(txFee) {
            return paychanlib.refundTxSatoshiPerByte(
                this.config._keyPair,
                this.state._fundingSource.txid,
                this.state._fundingSource.vout,
                this.state._redeemScript,
                this.config._expTime,
                this.state._fundingSource.value,
                this.config._changeAddress,
                txFee,
                this.config._network
            );
        }
    };

    this.getRefundTx = function() { return jsendError("Please 'setFundingSource' first") };

    this.openChannel = function(callback) {
        if (this.state._fundingSource.empty === true) {
            callback( jsendError("Please use 'setFundingSource' to add information about the funding transaction") );
        }

        this.payConn = new PayChanConnection(
            this.config._keyPair,
            this.state._redeemScript,
            this.state,
            this.config );
            // this.config._network);

        this.payConn.connect(
            this.state._serverInfo.openURL,
            this.state._serverInfo.fundingInfo.open_price,
            callback.bind(this, this.payConn));
    };


}


function getPathFromUrl(url) {
    return url.split("?")[0];
}

// ---- State + Library + REST -----
/**
 * Payment channel connection state object .
 * Create and send payments to a payment channel server endpoint.
 *
 * @constructor
 */
function PayChanConnection(clientKeyPair, redeemScript, parentState, parentConfig) {
    this.config = parentConfig;
    this.state = {
        _changeVal : parentState._fundingSource.value,
        _status: "init",
        ps : parentState,
        // initialized when channel is opened with this.connect
        _endpointURL : undefined,
        _lastPaymentPayload : undefined
    };

    this.valueLeft = function() { return this.state._changeVal };
    this.setValueLeft = function(valLeft) { this.state._changeVal = valLeft };

    this._createPaymentOfValue = function (val) {
        return this._createPayment(this.state._changeVal - val, this.config._network);
    };

    this._createPayment = paychanlib.createPayment.bind(undefined,
        clientKeyPair,
        this.state.ps._fundingSource.txid,
        this.state.ps._fundingSource.vout,
        redeemScript,
        this.config._changeAddress);

    this.connect = function(url, openPrice, callback) {
        var initPayment = this._createPaymentOfValue(openPrice);

        postWithPaymentPayload(
            getPathFromUrl(url),
            initPayment,
            this._handleOpenResponse.bind(this, initPayment, openPrice, callback),
            {   // query args to /channels/new
                client_pubkey  : paychanlib.util.hexFromPubKey(clientKeyPair),
                exp_time       : this.config._expTime,
                change_address : this.config._changeAddress
            }
        );
    };

    this._handleOpenResponse = function (payment, value, callback, response, data) {
        if ((response.statusCode === 201) || (response.statusCode === 202)) {
            this.state._status = data.channel_status;
            this.state._endpointURL = response.headers.location;
            this._registerSuccessfulPayment(payment, data.value_received);  //TODO: verify client-side
            callback(jsendWrap(data));
        }
        // else if  {
        //     this._registerSuccessfulPayment(payment, data.value_received);  //TODO: verify client-side
        //     console.log("Channel exhausted after initial payment");
        // }
        else if (response.statusCode === 409) { // channel already exists
            this.state._endpointURL = response.headers.location;
            
            callback( jsendError(response.statusMessage) );
        } else {
            callback( jsendError(response.statusMessage) );
        }
    };

    this._registerSuccessfulPayment = function(payment, val) {
        this.state._changeVal -= val;
        this.state._lastPaymentPayload = payment;
    };

    this.makePayment = function(val, callback) {
        var registerPaymentFunc = this._registerSuccessfulPayment.bind(this);
        var paymentPayload = this._createPaymentOfValue(val);

        if (this.state._endpointURL != undefined) {
            putWithPaymentPayload(
                this.state._endpointURL,
                paymentPayload,
                function (res,data) {
                    if ((res.statusCode === 200) || 
                        (res.statusCode === 202)) 
                    {
                        registerPaymentFunc(paymentPayload, data.value_received); //TODO: verify client-side
                        callback( jsendWrap(data) );
                    } else {
                        callback( jsendError(res.statusMessage) );
                    }
                });
        } else {
            return new Error("PayChanConnection is uninitialized")
        }
    };

    this._getLastPayment = function() {
        if (this.state._lastPaymentPayload != undefined) {
            return this.state._lastPaymentPayload;
        } else {
            return new Error("can't fetch last payment; no payments sent yet")
        }

    };

    this.deleteChannel = function(callback) {
        if (this.state._endpointURL != undefined) {
            deleteWithPaymentPayload(
                this.state._endpointURL,
                this._getLastPayment(),
                function (res) {
                    if (res.statusCode === 202) {
                        callback( jsendWrap({}) );
                    } else {
                        callback( jsendFail( res.statusMessage  ));
                    }
                }
            );
        } else {
            return new Error("no channel open yet")
        }
    };

    this.getChangeValue = function() {
        return this.state._changeVal;
    };

    this.getMaxValue = function() {
        return (this.state.ps._fundingSource.value - this.state.ps._serverInfo.openPrice);
    };

    this.getValueSent = function() {
        return (this.getMaxValue() - this.getChangeValue());
    };
}










// ---- HTTP -----
var Client = require('node-rest-client').Client;
var http = new Client();

var getJSON = function(url, callback) { http.get(url,callback) };


/**
 * Perform an HTTP request with the specified payment payload added as the "payment"
 * query string paramter.
 * */
function withPaymentPayload (method, theURL, payPayload, success, otherArgs) {
    var queryParams = { parameters: otherArgs || {} };
    queryParams.parameters.payment = payPayload;
    method(theURL, queryParams, function (data, response) {
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

function jsendFail(res) {
    return { status: "fail",
        data: res }
}

// ---- jsend JSON ---}


// -----Blockchain API-----

function blockchain_UnconfirmedTxInfo(address, callback) {
    http.get("https://chain.so/api/v2/get_tx_unspent/BTCTEST/" + address,
        function (json, response) {
            if (response.statusCode === 429) {
                callback( jsendError("chain.so: too many requests" + JSON.stringify(json)) );
            } else if (json.status === "success") {
                if (json.data.txs.length === 0) {
                    callback( jsendFail("Found no transactions paying to " + address) );
                } else {
                    var tx = json.data.txs[0];
                    var isResponseValid = tx.txid || tx.output_no || tx.value || tx.confirmations || "nope";

                    //Value DEBUG
                    console.log("API Value: ", tx.value);
                    console.log("Parsed Value: ", Math.floor(tx.value * 1e8));

                    if (isResponseValid !== "nope") {
                        callback (jsendWrap( {
                            txid: tx.txid,
                            vout: tx.output_no,
                            value: Math.floor(tx.value * 1e8),
                            confirmations: tx.confirmations }
                        ));
                    } else {
                        callback( jsendError("Invalid response format: " + JSON.stringify(json)) );
                    }
                }
            } else {
                callback(json);
            }
        }
    );
}

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
                    callback (jsendWrap( {
                        txid: fi.transaction_hash,
                        vout: fi.output_index,
                        value: fi.amount }
                    ));
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



module.exports = {
    PaymentChannel: PaymentChannel,
    blockchainAddrInfo: blockchain_getAddressInfo,
    blockchainUnconfirmedInfo: blockchain_UnconfirmedTxInfo,
    getJSON : getJSON
};
// @flow

var bitcoin = require('bitcoinjs-lib');
var paychanlib = require('./paychan-core');
var httplib = require('node-rest-client');
var util = require('./util');

function PaymentChannel(serverAddress, keyPair, expTime, network) {
    network = network || bitcoin.networks.bitcoin;

    var networkStr = util.isLiveNet(network) ? "live" : "test";
    this.config = {
        _serverEndpoint: serverAddress,
        _keyPair: keyPair,
        _expTime: expTime,
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
            this.getFundingAddress(function() { return this.state._serverInfo.openPrice });
        }
    };

    this.getFundingAddress = function (gotFundingAddressCallback) {
        if (this.state._fundingAddress) {
            gotFundingAddressCallback(
                null,
                this.state._fundingAddress,
                this.state._serverInfo.fundingInfo
            );
        } else {
            getJSON(this.config._serverEndpoint + this.config._basePath + "/fundingInfo" +
                "?client_pubkey=" + paychanlib.util.hexFromPubKey(this.config._keyPair) +
                "&exp_time=" + this.config._expTime,
                this._handleFundInfoRes.bind(this, gotFundingAddressCallback)
            );
        }
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
                    this.state._fundingAddress = fundingAddress;


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
     * Add information used to produce a payment transaction.
     * This includes some attributes of the transaction
     * output which funds the channel:
     *      txid of transaction, output index, output value
     * */
    this.setFundingInfo = function(txid, outputIndex, value, debug) {
        this.state._fundingSource.empty = false;
        this.state._fundingSource.txid = txid;
        this.state._fundingSource.vout = outputIndex;
        this.state._fundingSource.value = value;

        this._setupRefundTxGetter();

        this.config.debug = debug;
    };

    this.getRefundTx = function() { return util.jsendError("Please 'setFundingSource' first") };

    this.openChannel = function(changeAddress, callback) {
        if (this.state._fundingSource.empty === true) {
            callback( util.jsendError("Please use 'setFundingSource' to add information about the funding transaction") );
        }

        this.config._changeAddress = changeAddress;
        this.payConn = new PayChanConnection(this, changeAddress, this.state._redeemScript); //TODO: config?
            // this.config._network);

        this.payConn.connect(
            this.state._serverInfo.openURL,
            this.state._serverInfo.fundingInfo.open_price,
            callback.bind(this, this.payConn));
    };

    this._setupRefundTxGetter = function() {
        this.state._redeemScript = paychanlib.util.channelRedeemScript(
            this.config._keyPair,
            this.state._serverInfo.pubKey,
            this.config._expTime);

        this.getRefundTx = function(changeAddress, txFee) {
            return paychanlib.refundTxSatoshiPerByte(
                this.config._keyPair,
                this.state._fundingSource.txid,
                this.state._fundingSource.vout,
                this.state._redeemScript,
                this.config._expTime,
                this.state._fundingSource.value,
                changeAddress,
                txFee,
                this.config._network
            );
        }
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
function PayChanConnection(paymentChannel, changeAddress, redeemScript) {
    this.config = paymentChannel.config;

    this.config._changeAddress = changeAddress;
    this.config._redeemScript = redeemScript;
    this.config.fundingTxid = paymentChannel.state._fundingSource.txid;
    this.config.fundingVout = paymentChannel.state._fundingSource.vout;
    this.config.fundingValue = paymentChannel.state._fundingSource.value;
    this.config.openPrice = paymentChannel.state._serverInfo.openPrice;

    this.state = {};
    this.state._changeVal = this.config.fundingValue;
    this.state._status = "init";
    // initialized when channel is opened with "this.connect"
    this.state._endpointURL = undefined;
    this.state._lastPaymentPayload = undefined;

    var clientKeyPair = paymentChannel.config._keyPair;

    this.valueLeft = function() { return this.state._changeVal };
    this.setValueLeft = function(valLeft) { this.state._changeVal = valLeft };

    this._createPaymentOfValue = function (val) {
        return this._createPayment(this.state._changeVal - val, this.config._network);
    };

    this._createPayment = paychanlib.createPayment.bind(undefined,
        clientKeyPair,
        this.config.fundingTxid,
        this.config.fundingVout,
        this.config._redeemScript,
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
                change_address : this.config._changeAddress,
                test           : this.config.debug
            }
        );
    };

    this._handleOpenResponse = function (payment, value, callback, response, data) {
        if ((response.statusCode === 201) || (response.statusCode === 202)) {
            this.state._status = data.channel_status;
            this.state._endpointURL = response.headers.location;
            this._registerSuccessfulPayment(payment, data.value_received);  //TODO: verify client-side
            callback(util.jsendWrap(data));
        }
        // else if  {
        //     this._registerSuccessfulPayment(payment, data.value_received);  //TODO: verify client-side
        //     console.log("Channel exhausted after initial payment");
        // }
        else if (response.statusCode === 409) { // channel already exists
            this.state._endpointURL = response.headers.location;

            callback( util.jsendError(response.statusMessage) );
        } else {
            callback( util.jsendError(response.statusMessage) );
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
                        callback( util.jsendWrap(data) );
                    } else {
                        callback( util.jsendError(res.statusMessage) );
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
                        callback( util.jsendWrap({}) );
                    } else {
                        callback( util.jsendFail( res.statusMessage  ));
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
        return (this.config.fundingValue - this.config.openPrice);
    };

    this.getValueSent = function() {
        return (this.getMaxValue() - this.getChangeValue());
    };
}








// ---- HTTP -----
var Client = httplib.Client;
var http = new Client();

var getJSON = function(url, callback) { return http.get(url,callback) };

/**
 * Perform an HTTP request with the specified payment payload added as the "payment"
 * query string paramter.
 * */
function withPaymentPayload (method, theURL, payPayload, success, otherArgs) {
    var queryParams = { parameters: otherArgs || {} };
    queryParams.parameters.payment = payPayload;
    return method(theURL, queryParams, function (data, response) {
        success(response,data);
    });
}

var postWithPaymentPayload = withPaymentPayload.bind(undefined, http.post);
var putWithPaymentPayload = withPaymentPayload.bind(undefined, http.put);
var deleteWithPaymentPayload = withPaymentPayload.bind(undefined, http.delete);
// ---- HTTP -----



module.exports = {
    PaymentChannel: PaymentChannel,
    getJSON : getJSON
};

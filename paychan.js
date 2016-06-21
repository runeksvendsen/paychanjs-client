var paychanlib = require('./paychanlib');
var httplib = require('node-rest-client');

function isLiveNet(network) {
  return (network.pubKeyHash === 0x00 ? true : false);
}

// Parse a fixed-width (8 decimal places) Bitcoin float amount
//  into its corresponding satoshi amount (an integer).
// Parses eg. "0.001" (BTC) into 100000 (satoshi).
function parseFloatSatoshi(floatStr) {
  // Pad to be sure
  var afterDecimal = pad( floatStr.substr( floatStr.indexOf('.') + 1 ), 8, '0' );
  var beforeDecimal = floatStr.substr(0, floatStr.indexOf('.') );
  return (parseInt( beforeDecimal + afterDecimal ));
num.toFixed(8).replace('.', '')
}

// http://stackoverflow.com/a/10073788/700597
function pad(n, width, z) {
  z = z || '0'; n = n + '';
  return n.length >= width ? n : new Array(width - n.length + 1).join(z) + n;
}

function PaymentChannel(serverAddress, keyPair, expTime, network) {
    var networkStr = isLiveNet(network) ? "live" : "test";
    this.config = {
        _serverEndpoint: serverAddress,
        _keyPair: keyPair,
        _expTime: expTime,
        // _changeAddress: changeAddress,

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
     * Add information used to produce a payment transaction.
     * This includes the change address, to which excess funds are sent when
     * the channel is closed, as well as some attributes of the transaction
     * output which funds the channel:
     *      txid of transaction, output index, output value
     * */
    this.setPaymentInfo = function(txid, outputIndex, value) {
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

    this.getRefundTx = function() { return jsendError("Please 'setFundingSource' first") };

    this.openChannel = function(changeAddress, callback) {
        if (this.state._fundingSource.empty === true) {
            callback( jsendError("Please use 'setFundingSource' to add information about the funding transaction") );
        }

        this.config._changeAddress = changeAddress;
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


// jsend JSON
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
} // jsend JSON



module.exports = {
    PaymentChannel: PaymentChannel,
    getJSON : getJSON,
    isLiveNet: isLiveNet,
    parseFloatSatoshi
};

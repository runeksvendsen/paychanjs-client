var bitcoin = require('bitcoinjs-lib');
var network = bitcoin.networks.testnet;

var twelveHoursAgo = Math.floor(Date.now() / 1000) - (3600 * 12);
var expTime = 1465351052; // 1074300843;
var clientKeyPair = bitcoin.ECPair.fromWIF(
    'cRR4rbcKfvhpzZss76FpehUyogTWeSL2ChnT7z2ni9RhNzRpG92S', network);
var ENDPOINT = "https://paychan.runeks.me";


// ----REST-----
function doItAll() {
    getJSON(ENDPOINT + "/fundingInfo" +
        "?client_pubkey=" + hexFromPubKey(clientKeyPair) +
        "&exp_time=" + expTime,
        openChannel);
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




function openChannel(serverFundInfo, response) {
    console.log("Channel expiration date: " + new Date(expTime*1000));
    console.log(response);
    console.log(serverFundInfo);

    var redeemScript = channelRedeemScript(
        clientKeyPair,
        pubKeyFromHex(serverFundInfo.server_pubkey),
        expTime);

    var fundingAddress = redeemScriptAddress(redeemScript);
    console.log(fundingAddress);
    console.log("Server's calculated funding address matches ours?");
    console.log(fundingAddress === serverFundInfo.funding_address);

    var res = getFundingInfo(
        fundingAddress,
        gotFundingInfo.bind(
            undefined,
            redeemScript,
            response.headers.location,
            serverFundInfo.open_price
        )
    );
    console.log(res);
}

function gotFundingInfo(redeemScript, openURL, openPrice, fundInfo) {
    var fi = fundInfo;
    if  ((fi.transaction_hash === undefined) ||
        (fi.output_index === undefined) ||
        (fi.amount === undefined)) {
            console.log("Error: Blockchain API didn't return the requested information:");
            console.log(fi);
            return;
    }

    var state = new ChannelState(
        clientKeyPair,
        fi.transaction_hash,
        fi.output_index,
        fundInfo.amount,
        redeemScript,
        expTime,
        clientKeyPair.getAddress() // TODO
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
// ----REST-----


// ---- State + Library + REST -----
/**
 * Payment channel state object.
 * Create and send payments to a payment channel server endpoint.
 *
 * @constructor
 */
function ChannelState(clientKeyPair, funding_txid, funding_vout, chanValue, redeemScript, expTime, changeAddress) {
    this._changeVal = chanValue;

    this._createPayment = createPayment.bind(undefined,
        clientKeyPair,
        funding_txid,
        funding_vout,
        redeemScript,
        changeAddress);

    /**
     * Create refund transaction.
     *
     * @param {String} refundAddress - Return funds to this address
     * @param {Number} txFee - Bitcoin transaction fee
     * */
    this.getRefundTx = createRefundTx.bind(undefined,
        clientKeyPair,
        funding_txid,
        funding_vout,
        redeemScript,
        expTime,
        chanValue
    );

    this._createPaymentOfValue = function (val) {
        var newChangeVal = this._changeVal - val;
        var payment = this._createPayment(newChangeVal);
        this._changeVal = newChangeVal;
        return payment;
    };

    this.makePayment = function(val, callback) {
        var handlePayment = this._handlePaymentResponse.bind(this);
        var paymentPayload = this._createPaymentOfValue(val).toString('base64');
        if (this._channelURL != undefined) {
            putWithPaymentPayload(
                this._channelURL, // "&change_address=" + changeAddress,
                paymentPayload,
                function (res,data) {
                    handlePayment(paymentPayload, res, data);
                    callback(res,data);
                });
        } else {
            return new Error("ChannelState is uninitialized")
        }
    };

    this._getLastPayment = function() {
        if (this._lastPaymentPayload != undefined) {
            return this._lastPaymentPayload;
        } else {
            return new Error("can't fetch last payment; no payments sent yet")
        }

    };

    this._handlePaymentResponse = function(paymentPayload,res,data) {
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



// ----Script-----
var OP = bitcoin.opcodes;
var encodeInt = bitcoin.script.number.encode;

/**
 * @description
 * Create a redeemScript which can be satisfied in two ways:
 *
 * 1. By providing a signature from both the client and server
 * 2. After the specified expiration time has passed: only a signature from the client
 *
 * The channel payment transaction uses 1), while the channel refund transaction
 *  uses 2). The server will want to publish a channel payment transaction before the
 *  client refund transaction becomes valid.
 *
 * @param clientPubKey - Client public key (bitcoinjs-lib ECPair)
 * @param serverPubKey - Server public key (bitcoinjs-lib ECPair)
 * @param {uint} expTime - Channel expiration date (Unix timestamp).
 *      `Math.floor(Date.now() / 1000)` returns the current Unix timestamp.
 * @returns {Buffer} Script
 * */
function channelRedeemScript(clientPubKey, serverPubKey, expTime) {
    return bitcoin.script.compile([
        OP.OP_IF, // If top stack item is true-ish
            serverPubKey.getPublicKeyBuffer(), OP.OP_CHECKSIGVERIFY, // Check server sig
        OP.OP_ELSE,
            encodeInt(expTime), OP.OP_CHECKLOCKTIMEVERIFY, OP.OP_DROP, // Fail if expTime hasn't been passed yet
        OP.OP_ENDIF,
        clientPubKey.getPublicKeyBuffer(), OP.OP_CHECKSIG // Check client sig
    ]);
}

/**
 * Get the P2SH Bitcoin address for a given redeemScript.
 * Funds sent to the returned address can be redeemed by a Bitcoin
 *  transaction input which fulfills the specified redeemScript.
 * @param {Buffer} redeemScript - Specifies how funds can be redeemed
 * @returns {String} Bitcoin address
 */
function redeemScriptAddress(redeemScript) {
    return bitcoin.address.fromOutputScript(
        bitcoin.script.scriptHashOutput(
            bitcoin.crypto.hash160(redeemScript)),
        network);
}
// ----Script-----


// ----Util-----
function pubKeyFromHex(hexData) {
    return bitcoin.ECPair.fromPublicKeyBuffer(new Buffer(
        hexData, 'hex')
    );
}

function hexFromPubKey(ecPair) {
    return ecPair.getPublicKeyBuffer().toString('hex');
}

function serializeAmount(numSatoshis) {
    var amountBuf = new Buffer(8);
    bitcoin.bufferutils.writeUInt64LE(amountBuf, numSatoshis, 0);
    return amountBuf;
}
// ----Util-----


// ----PayChanLib-----
/**
 * @description
 * Create new channel payment (pure function). Library users will want to use
 *  the interface provided by {@link ChannelState}
 *
 * This function creates a new Bitcoin transaction which redeems the channel
 *  funding output, and from this redeemed value pays the specified change
 *  amount back to the client change address. The rest of the value is left
 *  to do with the server as it wishes. Decrementing the client change value
 *  is equivalent to increasing the amount paid to the server.
 * 
 * The returned payment data has the following format:
 * 
 * `|<64-bit unsigned integer (little-endian)>|<signature>|<sigHashByte>|`
 *
 * Example payment data with change value of **12345678899000** and
 *  sigHashByte of **0x83** (*SIGHASH_SINGLE | ANYONECANPAY*):
 *
 * `|3827ce733a0b0000`
 * `|3045022100ecdfb9e2f3e79a5786ba960230b8519ef68f5ed90ab92e760f1d355964814b4b` (wraps to next line)
 * `0220779cc7381acef9df92173aadc97faa2191c86fca789e724166c0249b0700635b|83|`
 * 
 * If changeAmount is less than the dust limit constant (DUST_LIMIT), this remaining
 * value is given up to the server/receiver.
 * 
 * @param clientKeyPair - Client key pair (bitcoinjs-lib ECPair); private key used to
 *      sign payment transaction
 * @param {String} fundingTxId - Funding transaction txid. The created payment transaction redeems the
 *      output in this funding transaction, which pays to the channel funding address
 *      (see {@link redeemScriptAddress})
 * @param {Number} fundingVout - Index/vout of funding output in funding transaction
 * @param {Buffer} redeemScript - Output of {@link channelRedeemScript}
 * @param {String} changeAddress - Client channel change address. Unspent channel value is sent
 *      here when the channel is closed.
 * @param {Number} changeAmount - Value left for the client/sender. This will decrement by the
 *      payment amount for each payment made over the channel.
 * */
function createPayment (clientKeyPair, fundingTxId, fundingVout, redeemScript, changeAddress, changeAmount) {
    // If the http change value is less than DUST_LIMIT, the http gets no change at all.
    // Done to avoid producing a transaction that will not circulate in the Bitcoin P2P network.
    var DUST_LIMIT = 700;
    var changeAmount = (changeAmount >= DUST_LIMIT) ? changeAmount : 0;

    var tx = new bitcoin.TransactionBuilder(network);

    // Add outpoint of funding transaction
    tx.addInput(fundingTxId, fundingVout);

    // Derive http/value sender change output script (scriptPubKey) from change address
    var scriptPubKey = bitcoin.address.toOutputScript(changeAddress, network); // Purity level: 97%
    // Add output paying changeAmount to changeAddress
    tx.addOutput(scriptPubKey, changeAmount);

    // Create something we can sign
    var txRaw = tx.buildIncomplete();

    // Drop http output if value is below dust limit.
    // The server/value receiver would be in its right mind to
    // reject payment transactions containing an output of value less than the dust limit,
    // so we let go of any value less than this.
    var sigHashType = (changeAmount >= DUST_LIMIT) ? bitcoin.Transaction.SIGHASH_SINGLE :
        bitcoin.Transaction.SIGHASH_NONE;
    // Make sure value receiver can add its own outputs to the payment transaction
    sigHashType = sigHashType | bitcoin.Transaction.SIGHASH_ANYONECANPAY;

    var txHash = txRaw.hashForSignature(0, redeemScript, sigHashType);
    var sig = clientKeyPair.sign(txHash);

    // Serialize signature and amount
    return Buffer.concat([
        serializeAmount(changeAmount),
        sig.toScriptSignature(sigHashType)
    ]);
}

/**
 * Create channel refund transaction (pure function). Library users will want to use
 *  the interface provided by {@link ChannelState}
 *
 * The Bitcoin transaction returned by this function redeems the funds sent to the
 *  channel funding address, and returns them to the specified refund address. This
 *  transaction will not be accepted by the network until the expiration date specified
 *  by {@link expTime} has passed.
 *
 * @param {ECPair} clientKeyPair - Client key pair (bitcoinjs-lib ECPair); private key used to sign refund transaction
 * @param {String} fundingTxId - Funding transaction txid.
 * @param {Number} fundingVout - Index/vout of funding output in funding transaction
 * @param {Buffer} redeemScript - Output of {@link channelRedeemScript}
 * @param {Number} expTime - Expiration date of the channel (Unix timestamp)
 * @param {Number} fundingVoutValue - Value of the funding output (output with index <fundingVout>
 *     in transaction with txid <fundingTxId>)
 * @param {String} refundAddress - Send refund to this address
 * @param {Number} txFee - Bitcoin transaction fee
 * */
function createRefundTx(
    clientKeyPair,    // Client private key, used to sign refund transaction
    fundingTxId,      // Funding transaction txid. The refund transaction redeems the output in the funding transaction paying to the channel funding address (see 'redeemScriptAddress')
    fundingVout,      // Index/vout of funding output
    redeemScript,     // Output of 'channelRedeemScript'
    expTime,          // The expiration date/time for the channel
    fundingVoutValue, // Value of funding output
    refundAddress,    // Return funds to this address
    txFee             // Bitcoin transaction fee of the refund transaction
    )
    {
        var tx = new bitcoin.TransactionBuilder(network);

        tx.setLockTime(expTime);
        tx.addInput(fundingTxId, fundingVout, 0xfffffffe);
        tx.addOutput(refundAddress, fundingVoutValue - txFee);

        var txRaw = tx.buildIncomplete();
        var hashType = bitcoin.Transaction.SIGHASH_ALL;
        // Get hash for signing for signing, where:
        var signatureHash = txRaw.hashForSignature(
            0, // Input index being signed
            redeemScript,
            hashType);    // SIGHASH_ALL: Sign all outputs
        var signature = clientKeyPair.sign(signatureHash);

        var inputScript = bitcoin.script.scriptHashInput(
            // scriptSig. Format for refund tx: "OP_FALSE <sig>" (top stack item is OP_FALSE)
            [signature.toScriptSignature(hashType), bitcoin.opcodes.OP_FALSE],
            redeemScript);

        txRaw.setInputScript(0, inputScript);
        return txRaw;
}
// ----PayChanLib-----






// ---- HTTP -----
var Client = require('node-rest-client').Client;
var http = new Client();

var getJSON = http.get;

/**
 * Perform an HTTP request with the payment payload added as a "payment"
 * query string paramter.
 * */
function withPaymentPayload (method, theURL, payPayload, success) {
    theURL = theURL + "&payment=" + payPayload;
    method(theURL, args, function (data, response) {
        success(response,data);
    });
}

var postWithPaymentPayload = withPaymentPayload.bind(undefined, http.post);
var putWithPaymentPayload = withPaymentPayload.bind(undefined, http.put);
var deleteWithPaymentPayload = withPaymentPayload.bind(undefined, http.delete);

// ---- HTTP -----





// -----Blockchain API-----

function getFundingInfo(fundingAddress, callback) {
    http.get("https://testnet3.toshi.io/api/v0/addresses/" + fundingAddress + "/unspent_outputs",
        function (jsonArray, response) {
            if (response.statusCode === 404) {
                console.log("Blockchain API: Found no transactions paying to " + fundingAddress);
                return;
            } else if (response.statusCode != 200) {
                console.log("Blockchain API: Unknown error: " + response);
                return;
            }

            callback(jsonArray.last()); // last item = first tx paying to address
        });
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







// RUN

doItAll();
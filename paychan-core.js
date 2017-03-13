// @flow

var bitcoin = require('bitcoinjs-lib');
var base64url = require('base64-url');

var defaultNet = bitcoin.networks.bitcoin;


/**
*  The basic idea behind a payment channel is updating a Bitcoin transaction,
* which spends funds sent to an address that requires two signatures to spend from:
* one from the sender and one from the receiver.
*
*  We can start out by constructing a Bitcoin transaction - which redeems the
* two-signature output - that sends all funds to the sender's change address.
* This is a payment transaction paying zero value to the receiver, but it allows the receiver to
* close the channel, by signing this transaction and publishing it.
*
*  If we take this initial payment transaction, and decrement the amount sent
* to the sender's change address by, say, 10000 satoshi, and make sure to sign
* the transaction with the ANYONECANPAY sig hash flag, we now have a transaction
* that the receiver can take and add its own output to, sign, publish and it will receive
* 10000 satoshi to its change address. If we decrement the sender change value
* again, by any amount, the transaction is now worth that much more to the receiver,
* who holds the private key required to produce the second signature.
*
*  The bitcoin (P2SH) address, that I said requires two signatures to spend from,
* actually also has one other way to be spent from. After a pre-defined expiration
* date, the sender can publish a transaction which contains only its own signature -
* leaving out the receiver's - and it will be accepted by the network. This gives
* the sender full protection against a disappearing receiver, while putting the
* burden on the receiver to make sure it publishes a payment transaction before
* the expiration date has passed. If it fails to do so, all the value it thought
* it had received can now be spent by the sender. No bitcoin exists until it is
* in the blockchain.
*
*  A payment transaction can be viewed as a means of payment - as opposed to
* money - a piece of
* information that someone finds valuable because they think they can get
* value out of it at a later date. In case of a half-signed Bitcoin transaction,
* this is achieved by signing and publishing it before the expiration date.
* The monetary unit is bitcoin, but the half-signed bitcoin transaction is
* accepted as a means of payment because it's a promise to be paid in bitcoins that's about
* as secure as a promise gets - depending only on the receiver's ability to keep
* its private key secret.
*/


/**
 * @description
 * Derive the channel funding address from the channel parameters.
 *
 * @param clientPubKey - Client public key (bitcoinjs-lib ECPair)
 * @param serverPubKey - Server public key (bitcoinjs-lib ECPair)
 * @param {uint} expTime - Channel expiration timestamp (Unix timestamp).
 *      `Math.floor(Date.now() / 1000)` returns the current Unix timestamp
 *      (seconds since Jan-01-1970).
*/
function deriveFundingAddress(clientPubKey, serverPubKey, expTime, network) {
    return redeemScriptAddress(channelRedeemScript(clientPubKey, serverPubKey, expTime), network);
}

/**
 * @description
 * Create new channel payment (pure function). Library users will want to use
 *  the interface provided by {@link PayChanConnection}
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
function createPayment (clientKeyPair, fundingTxId, fundingVout, redeemScript, changeAddress, changeAmount, network) {
    network = network || defaultNet;

    // If the client change value is less than DUST_LIMIT, the client gets no change at all.
    // Done to avoid producing a transaction that will not circulate in the Bitcoin P2P network.
    // Also: ignore underflow (cap to 0 in this case)
    var DUST_LIMIT = 500;
    var changeAmount = (changeAmount >= DUST_LIMIT) ? changeAmount : 0;

    var tx = new bitcoin.TransactionBuilder(network);

    // Add outpoint of funding transaction
    tx.addInput(fundingTxId, fundingVout);

    // Derive client/value sender change output script (scriptPubKey) from change address
    var scriptPubKey = bitcoin.address.toOutputScript(changeAddress, network);
    // Add output paying changeAmount to changeAddress
    tx.addOutput(scriptPubKey, changeAmount);

    // Create something we can sign
    var txRaw = tx.buildIncomplete();

    // Drop client output if value is below dust limit.
    // TODO: Should not happen automatically; create either payment
    //          with either change_value=0 OR change_value>=DUST_LIMIT
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
    return base64url.encode(
        Buffer.concat([
            serializeAmount(changeAmount),
            sig.toScriptSignature(sigHashType)
    ]));
}

/**
 * Get client/sender change amount for a payment created with 'createPayment'
 * TODO
 * */
// function paymentChangeAmount(paymentPayload) {
//     var buf = base64url.decode(paymentPayload);
// }



/**
 * Create channel refund transaction (pure function). Library users will want to use
 *  the interface provided by {@link PayChanConnection}
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
    txFee,             // Bitcoin transaction fee of the refund transaction
    network
)
{
    network = network || defaultNet;

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
    return txRaw; //.toString('hex');
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
function redeemScriptAddress(redeemScript, network) {
    return bitcoin.address.fromOutputScript(
        bitcoin.script.scriptHashOutput(
            bitcoin.crypto.hash160(redeemScript)),
        network || defaultNet);
}
// ----Script-----



/**
 * Helper function; allows specifying tx fee as satoshis/byte
 * */
function refundTxSatoshiPerByte(
    clientKeyPair, fundingTxId, fundingVout, redeemScript,
    expTime, fundingVoutValue, refundAddress, txFeeSatoshiPerByte, network)
{
    var txFromFee = createRefundTx.bind(undefined,
        clientKeyPair, fundingTxId, fundingVout, redeemScript,
        expTime, fundingVoutValue, refundAddress);

    var txByteSize = txFromFee(0, network).byteLength();
    var txFee = Math.ceil( txFeeSatoshiPerByte * txByteSize );

    return txFromFee(txFee, network);
}


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


module.exports = {
    createPayment: createPayment,
    createRefundTx: createRefundTx,
    refundTxSatoshiPerByte: refundTxSatoshiPerByte,
    deriveFundingAddress: deriveFundingAddress,
    util: {
        channelRedeemScript : channelRedeemScript,
        redeemScriptAddress : redeemScriptAddress,
        pubKeyFromHex : pubKeyFromHex,
        hexFromPubKey : hexFromPubKey
        // serializeAmount : serializeAmount
    }
};

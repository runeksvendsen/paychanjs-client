// @flow

var Client = require('node-rest-client').Client;
var http = new Client();
var util = require('./util');
var sha256 = require('sha.js')('sha256');


// Server function:
// deriveMockFundingInfo :: ChannelParameters -> FundingTxInfo
// deriveMockFundingInfo (CChannelParameters sendPK recvPK expTime) =
//     CFundingTxInfo
//         (HT.TxHash $ HC.hash256 $ cs . Bin.encode $ sendPK)
//         (toWord32 expTime `mod` 7)
//         12345678900000
//

function debug_deriveFakeFundingInfo(clientPubKey, expTime) {
    var pubKeyBuf = clientPubKey.getPublicKeyBuffer();
    var fakeTxIdBuf = sha256.update(pubKeyBuf).digest();

    return {
        txid: fakeTxIdBuf.reverse().toString('hex'),
        vout: expTime % 7,
        value: 12345678900000,
        confirmations: 0
    };
}




function blockchain_UnconfirmedTxInfo(address, callback, network) {
    var networkStr = util.isLiveNet(network) ? "BTC" : "BTCTEST";
    var url = "https://chain.so/api/v2/get_tx_unspent/" + [networkStr, address].join('/');
    return http.get( url, function (json, response) {
        if (response.statusCode === 429) {
            callback( util.jsendError("chain.so: too many requests" + JSON.stringify(json)) );
        } else if (json.status === "success") {
            if (json.data.txs.length === 0) {
                callback( util.jsendFail("Found no transactions paying to " + address) );
            } else {
                var tx = json.data.txs[0];
                var isResponseValid = tx.txid || tx.output_no || tx.value || tx.confirmations || true;

                if (isResponseValid) {
                    callback (util.jsendWrap( {
                        txid: tx.txid,
                        vout: tx.output_no,
                        value: util.parseFloatSatoshi(tx.value),
                        confirmations: tx.confirmations }
                    ));
                } else {
                    callback( util.jsendError("Invalid response format: " + JSON.stringify(json)) );
                }
            }
        } else {
            callback(json);
        }
    }).on('error', function (err, hello) { // .catch(function(err) {})
      console.log('chain.so, something went wrong:');
      console.log(err);
      console.log(hello);
      util.jsendError(err);
    });
}

function blockchain_getAddressInfo(fundingAddress, callback) {
    http.get("https://testnet3.toshi.io/api/v0/addresses/" + fundingAddress + "/unspent_outputs",
        function (jsonArray, response) {
            if (response.statusCode === 404) {
                callback( util.jsendError("Blockchain API: Found no transactions paying to " + fundingAddress) );
            } else if (response.statusCode != 200) {
                callback( util.jsendError("Blockchain API: Unknown error: " + response) );
            } else {
                var fi = jsonArray.last(); // last item = first tx paying to address

                if ((fi.transaction_hash === undefined) ||
                    (fi.output_index === undefined) ||
                    (fi.amount === undefined)) {
                    callback( util.jsendError("Error: Blockchain API didn't return the requested information: " + fi) );
                } else {
                    callback (util.jsendWrap( {
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




function fetchSettlementTxid(txid, vout, network, callback) {
    var networkStr = util.isLiveNet(network) ? "BTC" : "BTCTEST";
    var url = ["https://chain.so/api/v2/is_tx_spent", networkStr, txid, vout].join("/");
    http.get(url, callback);
}


module.exports = {
    addrInfo: blockchain_getAddressInfo,
    addrInfoUnconfimed: blockchain_UnconfirmedTxInfo,
    fetchSettlementTxid: fetchSettlementTxid,
    debug_deriveFakeFundingInfo: debug_deriveFakeFundingInfo
};




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

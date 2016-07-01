// @flow

var paychan = require('./paychan-state');
var blockchain = require('./blockchain-api');
var util = require('./util');

var bitcoin = require('bitcoinjs-lib');
var btcaddr = require('bitcoinaddress');
var $ = require('jquery');
var domready = require("domready");
var moment = require('moment');
var blockui = require('block-ui');
var httplib = require('node-rest-client');

var Raven = require('raven-js') ;


var http = new httplib.Client();

window.state = { checkFundingThread : null };

var MILLISECONDS_PER_MINUTE = 60000;
var DEFAULT_CHAN_DURATION_SEC  = 3600 * 24 * 3;
var DEFAULT_CHAN_DURATION = DEFAULT_CHAN_DURATION_SEC * 1000;


function setAlertStatus(id, text, type) {
    var msgField = $('#' + id);

    msgField.removeClass('alert-success');
    msgField.removeClass('alert-info');
    msgField.removeClass('alert-warning');
    msgField.removeClass('alert-danger');

    msgField.addClass('alert-' + type);

    msgField.html(text);
    msgField.show();
}

function setFundingStatus(text, type) {
    setAlertStatus('addressAlert', text, type);
}
function setPayMsg(text, type) {
    setAlertStatus('paymentAlert', text, type);
}
function setOpenMsg(text, type) {
    setAlertStatus('openAlert', text, type);
}

var getElem = function(id) { return document.getElementById(id) };
var setDate = function(unixTimestamp) {
    // whole minutes only
    unixTimestamp = unixTimestamp - (unixTimestamp % 60);
    getElem('expDatePicker').value = moment.unix(unixTimestamp).format().substring(0,19);
    checkDate();
    return getDate();
};
function setPrivKey(wifKey, network) {
    getElem('privKey').value = wifKey;
    if (wifKey !== "") {
        // Got private key
        $('#fundingStep').unblock();
        $('#refundAddress').val(
            bitcoin.ECPair.fromWIF(
                wifKey,
                network).getAddress() );
    }
    return wifKey;
}

function setChannelProgress(valueSent, maxValue, disabled) {
    if (disabled) {
      ('.progress-bar').attr("disabled", true);
    }
    var percentSent = Math.ceil( valueSent / maxValue * 100 );
    console.log(valueSent, maxValue, percentSent);
    $('.progress-bar').css('width', percentSent+'%');
}

function setNetwork (event, state) {
    console.log(event);
    console.log(state);
}


function disableElem(id) { $('#' + id).attr("disabled", true); }
function enableElem(id) { $('#' + id).removeAttr("disabled"); }

function btcAddrInit() {
    btcaddr.init({
        selector: ".bitcoin-address",
        template: "bitcoin-address-template",
        qr : {
            width: 128,
            height: 128,
            colorDark : "#000000",
            colorLight : "#ffffff",
            jQuery: $
        }
    });
}

function blockIt(id) {
  $(id).block({ message: null, fadeIn: 0, overlayCSS: { opacity: 0.58, cursor: null } } );
}

function setupFundingInfoBtn(wifKey, network) {
  $('#getServerInfo').off('click'); // IMPORTANT (otherwise, 10 funding-check threads are fired off if the user clicks the button 10 times)
  $('#getServerInfo').on('click', function () {
      disableElem('enableTestnet');

      // Stop checking old funding address
      var checkThreadId = window.state.checkFundingThread;
      if (checkThreadId !== null) { clearTimeout(checkThreadId); }

      // -- Follow getServerFundingInfo ---
      getServerFundingInfo(
          getElem('serverAddress').value,
          bitcoin.ECPair.fromWIF(wifKey, network),
          getDate(),
          network
          // getElem('refundAddress').value,
      );
  });
}

domready(function () {
    //DEBUG
    localStorage.clear();

    Raven.config('https://e409adce589a4b2fba3ceb0ea008a574@app.getsentry.com/85025').install();

    blockIt('#fundingStep');
    blockIt('#openStep');
    blockIt('#payStep');

    // press Enter to send payment
    $('#paymentAmount').keydown(function(event) {
        var btn = $('#makePayment');
        if ( (event.keyCode == 13) && !(btn.attr("disabled")) ) {
            btn.click();
        }
    });

    $('#genPrivKey').on('click', function () {
        // disableElem('enableTestnet');
        var network = window.config.useTestnet ?
            bitcoin.networks.testnet : bitcoin.networks.bitcoin;

        var newWifKey = newWifPrivateKey(network);
        setPrivKey(newWifKey, network);
        setupFundingInfoBtn(newWifKey, network);
    });

    $('expDatePicker').on('change', checkDate);
    $('refundAddress').on('keyup', checkRefundAddress);
    $('paymentAmount').on('keyup', checkPaymentAmount);

    disableElem('getServerInfo');
    disableElem('openChannel');
    disableElem('getRefundTx');
    disableElem('makePayment');
    disableElem('closeChannel');

    //Init UI input values: retrieve saved or generate new
    setDate( (moment().unix() + DEFAULT_CHAN_DURATION_SEC) ); // localStorage.exp ||
    setPrivKey(localStorage.wifkey || "");
    getElem('refundAddress').value = localStorage.refundAddress || "";
    getElem('paymentAmount').value = "50";
});


function showBTCAmount(numSatoshis) {
    return (numSatoshis / 1e8) + " BTC";
}


function getServerFundingInfo(serverAddress, keyPair, expTime, network) {
    var chanState = new paychan.PaymentChannel(
        serverAddress,
        keyPair,
        expTime,
        network);

    setFundingStatus("Contacting server...", "warning");

    try {
        chanState.getFundingInfo(function (fundingAddress, openPrice, fundingTxMinConf) {
            displayFundingInfoResponse(fundingAddress, openPrice);

            // DEBUG
            // Fake-fund the channel
            enableElem('fakeFund');
            $('#fakeFund').on('click', function () {
                window.state.checkFundingThread = "dont";
                channelFundingSuccess(
                    blockchain.debug_deriveFakeFundingInfo(keyPair, expTime),
                    chanState,
                    fundingAddress,
                    network,
                    true);
            });

            // -- Follow checkChannelFunding ---
            checkChannelFunding(fundingAddress, chanState, openPrice, network);

        });
    } catch(error) {
        setFundingStatus("Error: " + error, "danger");
        Raven.captureException(error);
    }
}


function displayFundingInfoResponse(fundingAddress, openPrice) {
    console.log("Funding address: " + fundingAddress);

    var mkAddrHTML = function (addr) {
        return '<strong data-bc-label="Payment channel" class="bitcoin-address" data-bc-address="' +
            addr + '">' + addr + '</strong>';
    };
    var msg = mkAddrHTML(fundingAddress) + "<br>" +
        "Open price: " + showBTCAmount(openPrice);

    setFundingStatus(msg, "info");

    btcAddrInit();
}

function checkChannelFunding(fundingAddress, chanState, openPrice, network) {
    if (window.state.checkFundingThread !== "dont") {
        blockchain.addrInfoUnconfimed(fundingAddress, addrInfoCallback, network);
    }

    function addrInfoCallback(json) {
        if (json.status === "success") {
            channelFundingSuccess(json.data, chanState, fundingAddress, network);
        } else if (json.status === "fail") {
            console.log("Found no transactions paying to " + fundingAddress +
                ". Checking again in 10s.");
            // No transactions paying to address yet
            window.state.checkFundingThread =
                setTimeout(
                    checkChannelFunding.bind(undefined, fundingAddress, chanState, openPrice, network),
                    10000);
            // ^ Loop ^
        } else {
            setFundingStatus("Error: " + (json.message || json.data), "danger");
        }
    }
}


function channelFundingSuccess(fi, chanState, fundingAddress, network, debug) {
    setFundingStatus("Funded with " + (fi.value / 1e8) + " BTC", "success");

    chanState.setFundingInfo( fi.txid, fi.vout, fi.value, debug || false );

    // Lock in channel parameters
    disableElem('genPrivKey');
    disableElem('expDatePicker');

    // Enable "Open channel" section & set up button
    $('#openStep').unblock();
    enableElem('openChannel');

    $('#openChannel').off().on('click',
        // -- Follow openChannel ---
        openChannel.bind(undefined, chanState, fundingAddress, fi, network));

    // Enable "refund transaction" button
    enableElem('getRefundTx');
    $('#getRefundTx').off().on('click', publishRefundTxDialog.bind(undefined, chanState, network) );

    //Disable "Get funding address" + "Generate key" button
    disableElem('getServerInfo');
    disableElem('genPrivKey');
}

function publishRefundTxDialog(chanState, network) {
    var fee = parseInt( prompt(
        "Please enter transaction fee in satoshis per byte.\
        \
        \n\nIf you don't know what fee to choose, press cancel and visit https://bitcoinfees.21.co/.",
        "30") );
    var changeAddress = getElem('refundAddress').value;
    if (!isNaN(fee)) {
        var txHexStr = chanState.getRefundTx(changeAddress, fee).toHex();

        var mailtoLink = "mailto:?subject=Payment channel refund transaction&body=";
        var br = "%0D%0A";
        window.open( mailtoLink +
            "Hello me" + br + br +
            "Here's a hex-encoded refund transaction: " + txHexStr + br + br +
            "Kind regards," + br + "me");

        // var pushURL = "https://" + (util.isLiveNet(network) ? "btc" : "tbtc") +
        //         ".blockr.io/api/v1/tx/push";
        // http.post(pushURL, { data: { hex: txHexStr } }, function(data,arg2) {
        //
        //     if (data.status === "success") {
        //         nalert( "success! tx hash: " + data.data );
        //     } else {
        //         nalert( "Something went wrong :\ " + data.message);
        //     }
        // }).on('error', function (err, hello) { // .catch(function(err) {})
        //     console.log('push tx: something went wrong:');
        //     console.log(err);
        //     console.log(hello);
        // });
    }
}

function openChannel(chanState, fundingAddress, fi, network) {
    $('#openSpinner').show();

    disableElem('openChannel');
    disableElem('getServerInfo');
    disableElem('refundAddress');

    try {
        chanState.openChannel(getElem('refundAddress').value, function (payConn, payInfo) {
            $('#closeChannel').off();
            $('#closeChannel').on('click', deleteChannel.bind(undefined, payConn, network));
            enableElem('closeChannel');

            // -- You've reached the end ---
            $('#payStep').unblock();
            displayRegisterPayment(payInfo, payConn);
            handleChannelStatus(payInfo.channel_status, payConn, fundingAddress, network);
        });
    } catch(e) {
        setOpenMsg("Error: " + e, "danger");
        Raven.captureException(e);
    } finally {
        $('#openSpinner').hide();
    }
}


// Payment
function setupPaymentButton(payConn, fundingAddress, network) {
    enableElem('makePayment');
    $('#makePayment').off('click');
    $('#makePayment').click( function() {
        var amount = getElem('paymentAmount').value;
        makePayment(amount, payConn, fundingAddress, network);
    });
}

function makePayment(amount, payConn, fundingAddress, network) {
    disableElem('makePayment');

    try {
        payConn.makePayment(amount, function (res) {
            if (res.status === "success") {
                var json = res.data;
                displayRegisterPayment(json, payConn, fundingAddress);
                handleChannelStatus(json.channel_status, payConn, fundingAddress, network)
            } else {
                setPayMsg("Error: " + (json.message || json.data), "danger");
            }
        });
    } catch(e) {
        Raven.captureException(e);
    }
}

function displayRegisterPayment(json, payConn, fundingAddress, done) {
    var chanStatus = json.channel_status;

    if (json.value_received) {
        setChannelProgress(payConn.getValueSent(), payConn.getMaxValue(), done);
        setPayMsg(
          "Sent payment of <strong>" +
           json.value_received +
           "</strong> satoshi (" +
           ( payConn.getMaxValue() - payConn.getValueSent() ) +
           " satoshi left to send)"
           , "success");
    }
}

function handleChannelStatus(chanStatus, payConn, fundingAddress, network) {
    // handle status change
    if (chanStatus === "open") {
        setupPaymentButton(payConn, fundingAddress, network);
    } else if (chanStatus === "closed") {
        setPayMsg("Channel closed. Looking up settlement transaction ID...", "info");

        disableElem('closeChannel');
        disableElem('makePayment');
        disableElem('getServerInfo');
        localStorage.removeItem("wifkey");

        var txid = payConn.config.fundingTxid;
        var vout = payConn.config.fundingVout;
        var fakeJsonRes = { status: "success", data: { is_spent: false } }; //provoke a re-scheduling of the checking thread

        handleSettlementFetchResponse(txid, vout, network, fakeJsonRes);
    } else {
        setPayMsg("BUG. chanStatus: " + chanStatus, "danger");
    }
} // Payment


// Deletion
function deleteChannel(payConn, network) {
    disableElem('makePayment');
    try {
        payConn.deleteChannel(function (json) {
            if (json.status === "success") {
                handleChannelStatus("closed", payConn, undefined, network);
            } else {
                setPayMsg("Error: " + (json.message || json.data), "danger");
                enableElem('makePayment');
            }
        })
    } catch(e) {
        Raven.captureException(e);
    }
} // Deletion


// Settlement tx info
function setSettlementInfoMsg(txid, network) {
    var netStr = util.isLiveNet(network) ? "BTC" : "tBTC";
    var link = "https://www.blocktrail.com/" + netStr + "/tx/" + txid;
    var msg = "Link to <a target='_blank' href='" + link + "'>settlement transaction</a>";
    setPayMsg( msg, "success");
}

function handleSettlementFetchResponse(txid, vout, network, json) {
    if (json.status === "success") {
        if (json.data.is_spent === true) {
            setSettlementInfoMsg( json.data.spent.txid, network );
        } else {
            setTimeout(
              blockchain.fetchSettlementTxid.bind(
                undefined,
                txid,
                vout,
                network,
                handleSettlementFetchResponse.bind(undefined, txid, vout, network)),
              8000);
        }
    } else {
        setPayMsg("Failed getting settlement txid: " + JSON.stringify(json), "danger");
    }
}



function newWifPrivateKey(network) {
    return bitcoin.ECPair.makeRandom( { compressed: true, network: network } ).toWIF();
}




// --- UI input ----
function getDate() {
    var data = getElem('expDatePicker').value;

    if ( !(data === "") ) {
        var ts = moment(data).unix();
        enableElem('getServerInfo');
        return ts;
    } else {
        disableElem('getServerInfo');
        return undefined;
    }
}

function checkDate() {
    var unixTimestamp = getDate();
    if ( unixTimestamp !== undefined ) {
        enableElem('getServerInfo');
        // getElem('chanDuration').innerHTML = moment.unix(unixTimestamp).fromNow();
    } else {
        disableElem('getServerInfo');
        // getElem('chanDuration').innerHTML = "---";
    }
}

function checkPaymentAmount() {
    var amount = parseAmount( getElem('paymentAmount').value );
    if (amount) {
        enableElem('makePayment');
    } else {
        disableElem('makePayment');
    }
}

function checkRefundAddress() {
    var addr = getElem('refundAddress').value;
    if (parseRefundAddress(addr)) {
        enableElem('getRefundTx');
        enableElem('openChannel');
    } else {
        disableElem('getRefundTx');
        disableElem('openChannel');
    }
}

// Parsing
function parseRefundAddress(b58addr) {
    try {
        bitcoin.address.fromBase58Check(b58addr);
    } catch(err) {
        return undefined;
    }
    return b58addr;
}

function parseAmount(amountStr) {
    var res = parseInt(amountStr);
    if (!isNaN(res)) {
        return (res > 0 ? res : undefined);
    } else {
        return undefined;
    }
}
///Parsing


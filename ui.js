var paychanlib = require('./paychanlib');
var paychan = require('./paychan');
var blockchain = require('./blockchain-api');

var bitcoin = require('bitcoinjs-lib');
var btcaddr = require('bitcoinaddress');
var $ = require('jquery');
var domready = require("domready");
var moment = require('moment');
var blockui = require('block-ui');
var httplib = require('node-rest-client');

var http = new httplib.Client();

window.state = { checkFundingThread : null };

MILLISECONDS_PER_MINUTE = 60000;
DEFAULT_CHAN_DURATION_SEC  = 3600 * 24 * 3;
DEFAULT_CHAN_DURATION = DEFAULT_CHAN_DURATION_SEC * 1000;

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

var getElem = function(id) { return document.getElementById(id) };
var setDate = function(unixTimestamp) {
    // whole minutes only
    unixTimestamp = unixTimestamp - (unixTimestamp % 60);
    getElem('expDatePicker').value = moment.unix(unixTimestamp).format().substring(0,19);
    checkDate();
    return getDate();
};
function getPrivKey() {
    var val = getElem('privKey').value;
    return (val === "" ? undefined : val);
}
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

var createCheckbox = function() {
    return $("<input>", {
        type: "checkbox",
        "class": "switch"
    }).appendTo("body");
};

function blockIt(id) {
  // $('.blockUI.blockOverlay').css("opacity", 0.45);
  $('#' + id).block({ message: null, fadeIn: 0, overlayCSS: { opacity: 0.48, cursor: null } } );
}

function setupFundingInfoBtn(wifKey, network) {
  $('#getServerInfo').off('click'); // IMPORTANT (otherwise, 10 funding-check threads are fired off if the user clicks the button 10 times)
  $('#getServerInfo').on('click', function () {
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

    blockIt('fundingStep');
    blockIt('openStep');
    blockIt('payStep');

    // press Enter to send payment
    $('#paymentAmount').keydown(function(event) {
        var btn = $('#makePayment');
        if ( (event.keyCode == 13) && !(btn.attr("disabled")) ) {
            btn.click();
        }
    });

    $('#genPrivKey').on('click', function () {
        disableElem('enableTestnet');
        var network = window.config.useTestnet ?
            bitcoin.networks.testnet : bitcoin.networks.bitcoin;

        var newWifKey = newWifPrivateKey(network);
        setPrivKey(newWifKey, network);
        setupFundingInfoBtn(newWifKey, network);
    });

    $('expDatePicker').on('change', checkDate);
    $('refundAddress').on('keyup', storeRefundAddress);
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
    chanState.getFundingAddress(function (error, fundingAddress, fi) {
        if (error == null) {
            // TODO: saveState

            console.log("Funding address: " + fundingAddress);

            var mkAddrHTML = function(addr) {
                return '<strong data-bc-label="Payment channel" class="bitcoin-address" data-bc-address="' +
                    addr + '">' + addr + '</strong>';
            };
            var msg =  mkAddrHTML(fundingAddress) + "<br>" +
                    "Open price: " + showBTCAmount(fi.open_price);

            setFundingStatus(msg, "info");

            btcAddrInit();
            // btcaddr.scan();

            // -- Follow checkChannelFunding ---
            checkChannelFunding(fundingAddress, chanState, chanState.getOpenPrice(), network);

            // DEBUG
            // Fake-fund the channel
            enableElem('debug');
            $('#debug').on('click', function() {
                channelFundingSuccess( {
                    txid : "09724b73aaedff15db839babe3ad3e6bc85cd3e4c1c7130c3a4d3d2891951a2b",
                    vout : 1,
                    value : 100000 },
                    chanState, fundingAddress);
            });

        } else {
            setFundingStatus("Error: " + error, "danger");
        }
    });

}

function checkChannelFunding(fundingAddress, chanState, openPrice, network) {
    blockchain.addrInfoUnconfimed(fundingAddress, function(json) {
        if (json.status === "success") {
            channelFundingSuccess(json.data, chanState, fundingAddress, network);
        } else if (json.status === "fail") {
            console.log("Found no transactions paying to " + fundingAddress +
                ". Checking again in 10s.");
            // No transactions paying to address yet
            window.state.checkFundingThread =
                setTimeout(
                    checkChannelFunding.bind(undefined, fundingAddress, chanState, network),
                    10000);
            // ^ Loop ^
        } else {
            setFundingStatus("Error: " + (json.message || json.data), "danger");
        }
    });
}


function channelFundingSuccess(fi, chanState, fundingAddress, network) {
    setFundingStatus("Funded with " + (fi.value / 1e8) + " BTC", "success");

    chanState.setPaymentInfo( fi.txid, fi.vout, fi.value );

    // Lock in channel parameters
    disableElem('genPrivKey');
    disableElem('expDatePicker');

    // Enable "Open channel" section & set up button
    $('#openStep').unblock();
    enableElem('openChannel');

    $('#openChannel').off();
    $('#openChannel').on('click',
        // -- Follow openChannel ---
        openChannel.bind(undefined, chanState, fundingAddress, fi, network));

    // Enable "refund transaction" button
    enableElem('getRefundTx');
    $('#getRefundTx').off();
    $('#getRefundTx').on('click', function () {
        var fee = prompt(
            "Please enter transaction fee in satoshis per byte.\
            \
            \n\nIf you don't know what fee to choose, press cancel and visit https://bitcoinfees.21.co/.",
            "30");
        var changeAddress = getElem('refundAddress').value;
        if (!isNaN(parseInt(fee))) {
            alert(chanState.getRefundTx(changeAddress, parseInt(fee)).toHex());
        }
    });

    //Disable "Get funding address" + "Generate key" button
    disableElem('getServerInfo');
    disableElem('genPrivKey');
}


function openChannel(chanState, fundingAddress, fi, network) {
    $('#openSpinner').show();

    disableElem('openChannel');
    disableElem('getServerInfo');
    disableElem('refundAddress');

    chanState.openChannel(getElem('refundAddress').value, function(payConn, json) {
        if (json.status === "success") {
            $('#openSpinner').hide();

            $('#closeChannel').off();
            $('#closeChannel').on('click', deleteChannel.bind(undefined, payConn));
            enableElem('closeChannel');

            // -- You've reached the end ---
            $('#payStep').unblock();
            displayRegisterPayment(json.data, payConn);
            handleChannelStatus(json.data.channel_status, payConn, fundingAddress, network);

            // Save open channel info
            localStorage.openChannel = { //s[fundingAddress] = {
                value_left : payConn.valueLeft(),
                channel_funding_info: fi };
        } else {
            setFundingStatus("Error: " + (json.message || json.data), "danger");
        }
    });
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

    payConn.makePayment(amount, function(res) {
        if (res.status === "success") {
            var json = res.data;
            displayRegisterPayment(json, payConn, fundingAddress);
            handleChannelStatus(json.channel_status, payConn, fundingAddress, network)
        } else {
            setFundingStatus("Error: " + (json.message || json.data), "danger");
        }
    });
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

        var txid = payConn.state.ps._fundingSource.txid;
        var vout = payConn.state.ps._fundingSource.vout;
        var networkStr = isLiveNet(network) ? "BTC" : "BTCTEST";
        setTimeout(function () {
            fetchSettlementTxid(networkStr, txid, vout);
        }, 3000);
    } else {
        setFundingStatus("ERROR: BUG. chanStatus: " + chanStatus, "danger");
    }
} // Payment


// Deletion
function deleteChannel(payConn) {
    disableElem('makePayment');
    payConn.deleteChannel(function (json) {
        if (json.status === "success") {
            handleChannelStatus("closed", payConn);
        } else {
            setFundingStatus("Error: " + (json.message || json.data), "danger");
            enableElem('makePayment');
        }
    })
} // Deletion


// Settlement tx info
function setSettlementInfoMsg(txid) {
    var link = "https://www.blocktrail.com/tBTC/tx/" + txid;
    var msg = "<a target='_blank' href='" + link + "'>Link to settlement transaction</a>";
    setPayMsg( msg, "success");
}

function fetchSettlementTxid(networkStr, txid, vout) {
    var url = ["https://chain.so/api/v2/is_tx_spent", networkStr, txid, vout].join("/");
    http.get(url,
        function(json) {
            if (json.status === "success") {
                if (json.data.is_spent === true) {
                    setSettlementInfoMsg( json.data.spent.txid );
                } else {
                    setTimeout(function () { fetchSettlementTxid(networkStr, txid, vout); }, 10000);
                }
            } else {
                console.log("Failed getting settlement txid: " + JSON.stringify(json));
            }
        }
    );
} // Settlement fetch txid




// UI state
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


function newWifPrivateKey(network) {
    return bitcoin.ECPair.makeRandom( { compressed: true, network: network } ).toWIF();
}


function storeRefundAddress() {
    var addr = parseRefundAddress( getElem('refundAddress').value );
    if (addr) {
        enableElem('getRefundTx');
        enableElem('openChannel');
        localStorage.refundAddress = addr;
    } else {
        disableElem('getRefundTx');
        disableElem('openChannel');
    }
}
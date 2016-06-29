// @flow

module.exports = {
  parseFloatSatoshi: parseFloatSatoshi,
  isLiveNet: isLiveNet,
  pad: pad,
  jsendError: jsendError,
  jsendWrap: jsendWrap,
  jsendFail: jsendFail
};

function isLiveNet(network) {
  return (network.pubKeyHash === 0x00);
}

// Parse a fixed-precision (8 decimal places) number represented as a string
//  into an integer by multiplying with 1e8.
// Parses eg. "0.001" (BTC) into 100000 (satoshi).
function parseFloatSatoshi(floatStr, w) {
  w = w || 8;
  // Pad to be sure
  var afterDecimal = pad( floatStr.substr( floatStr.indexOf('.') + 1 ), w, '0' );
  var beforeDecimal = floatStr.substr(0, floatStr.indexOf('.') );
  return (parseInt( beforeDecimal + afterDecimal ));
}

// http://stackoverflow.com/a/10073788/700597
function pad(n, width, z) {
  z = z || '0'; n = n + '';
  return n.length >= width ? n : new Array(width - n.length + 1).join(z) + n;
}


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

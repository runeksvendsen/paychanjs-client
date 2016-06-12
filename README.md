# Client library for: RESTful Bitcoin payment channel protocol



* * *

## Core functions

TODO: Document ChannelState object.

For now this documentation functions as a specification of the payment data format.


### createPayment(clientKeyPair, fundingTxId, fundingVout, redeemScript, changeAddress, changeAmount) 

Create new channel payment (pure function). Library users will want to use
 the interface provided by [ChannelState](#channelstate)

This function creates a new Bitcoin transaction which redeems the channel
 funding output, and from this redeemed value pays the specified change
 amount back to the client change address. The rest of the value is left
 to do with the server as it wishes. Decrementing the client change value
 is equivalent to increasing the amount paid to the server.

The returned payment data has the following format:

`|<64-bit unsigned integer (little-endian)>|<signature>|<sigHashByte>|`

Example payment data with change value of **12345678899000** and
 sigHashByte of **0x83** (*SIGHASH_SINGLE | ANYONECANPAY*):

`|3827ce733a0b0000`
`|3045022100ecdfb9e2f3e79a5786ba960230b8519ef68f5ed90ab92e760f1d355964814b4b` (wraps to next line)
`0220779cc7381acef9df92173aadc97faa2191c86fca789e724166c0249b0700635b|83|`

If changeAmount is less than the dust limit constant (DUST_LIMIT), this remaining
value is given up to the server/receiver.

**Parameters**

**clientKeyPair**: , Client key pair (bitcoinjs-lib ECPair); private key used to
     sign payment transaction

**fundingTxId**: `String`, Funding transaction txid. The created payment transaction redeems the
     output in this funding transaction, which pays to the channel funding address
     (see [redeemScriptAddress](#redeemscriptaddress))

**fundingVout**: `Number`, Index/vout of funding output in funding transaction

**redeemScript**: `Buffer`, Output of [channelRedeemScript](#channelredeemscript)

**changeAddress**: `String`, Client channel change address. Unspent channel value is sent
     here when the channel is closed.

**changeAmount**: `Number`, Value left for the client/sender. This will decrement by the
     payment amount for each payment made over the channel.


### createRefundTx(clientKeyPair, fundingTxId, fundingVout, redeemScript, expTime, fundingVoutValue, refundAddress, txFee) 

Create channel refund transaction (pure function). Library users will want to use
 the interface provided by [ChannelState](#channelstate)

The Bitcoin transaction returned by this function redeems the funds sent to the
 channel funding address, and returns them to the specified refund address. This
 transaction will not be accepted by the network until the expiration date specified
 by expTime has passed.

**Parameters**

**clientKeyPair**: `ECPair`, Client key pair (bitcoinjs-lib ECPair); private key used to sign refund transaction

**fundingTxId**: `String`, Funding transaction txid.

**fundingVout**: `Number`, Index/vout of funding output in funding transaction

**redeemScript**: `Buffer`, Output of [channelRedeemScript](#channelredeemscript)

**expTime**: `Number`, Expiration date of the channel (Unix timestamp)

**fundingVoutValue**: `Number`, Value of the funding output (output with index <fundingVout>
    in transaction with txid <fundingTxId>)

**refundAddress**: `String`, Send refund to this address

**txFee**: `Number`, Bitcoin transaction fee


### channelRedeemScript(clientPubKey, serverPubKey, expTime) 

Create a redeemScript which can be satisfied in two ways:

1. By providing a signature from both the client and server
2. After the specified expiration time has passed: only a signature from the client

The channel payment transaction uses 1), while the channel refund transaction
uses 2). The server will want to publish a channel payment transaction before the
client refund transaction becomes valid.

**Parameters**

**clientPubKey**: , Client public key (bitcoinjs-lib ECPair)

**serverPubKey**: , Server public key (bitcoinjs-lib ECPair)

**expTime**: `uint`, Channel expiration date (Unix timestamp).
`Math.floor(Date.now() / 1000)` returns the current Unix timestamp.

**Returns**: `Buffer`, Script


### redeemScriptAddress(redeemScript) 

Get the P2SH Bitcoin address for a given redeemScript.
Funds sent to the returned address can be redeemed by a Bitcoin
transaction input fulfilling the specified redeemScript.

**Parameters**

**redeemScript**: `Buffer`, Specifies how funds can be redeemed

**Returns**: `String`, Bitcoin address


* * *











// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract EnergyData {
struct Record {
string deviceId;
string dataHash;
uint256 timestamp;
}

Record[] public records;

event DataStored(
string deviceId,
string dataHash,
uint256 timestamp
);

function storeData(
string memory _deviceId,
string memory _dataHash
) public {

Record memory newRecord = Record({
deviceId: _deviceId,
dataHash: _dataHash,
timestamp: block.timestamp
});

records.push(newRecord);

emit DataStored(_deviceId, _dataHash, block.timestamp);
}

function getRecord(uint256 index)
public
view
returns (string memory, string memory, uint256)
{
Record memory r = records[index];
return (r.deviceId, r.dataHash, r.timestamp);
}

function getCount() public view returns (uint256) {
return records.length;
}
}



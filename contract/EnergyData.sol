// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// SmartVehicleKey
contract SmartVehicleKey {
    // ---------- roles ----------
    address public owner;                    
    mapping(address => bool) public writers; 

    // ---------- key authorization (access control) ----------
    mapping(string => bool) public authorizedKeys; 

    // ---------- records ----------
    struct AccessLog {
        string vin;
        string uid;
        string state;     
        bool granted;     
        string prevHash;
        string logHash;
        uint256 blockTime;
    }

    struct OdometerRecord {
        string vin;
        uint256 odometerMeters; // km x 1000 (12500.059 km => 12500059)
        string prevHash;
        string odoHash;
        uint256 blockTime;
    }

    AccessLog[] public accessLogs;
    OdometerRecord[] public odometerRecords;

    mapping(string => uint256) public lastOdometerMeters;
    mapping(bytes32 => bool) private storedHashes;       

    // ---------- events ----------
    event KeyAuthorized(string uid);
    event KeyRevoked(string uid);
    event WriterUpdated(address writer, bool allowed);
    event AccessLogged(string vin, string uid, bool granted, string logHash, uint256 blockTime);
    event OdometerLogged(string vin, uint256 odometerMeters, string odoHash, uint256 blockTime);

    // ---------- modifiers ----------
    modifier onlyOwner() {
        require(msg.sender == owner, "Only TA (owner)");
        _;
    }

    modifier onlyWriter() {
        require(writers[msg.sender], "Not an authorized writer");
        _;
    }

    constructor() {
        owner = msg.sender;
        writers[msg.sender] = true;
    }

    // ---------- key management (TA / Fleet Portal) ----------
    function authorizeKey(string calldata uid) external onlyOwner {
        authorizedKeys[uid] = true;
        emit KeyAuthorized(uid);
    }

    function revokeKey(string calldata uid) external onlyOwner {
        authorizedKeys[uid] = false;
        emit KeyRevoked(uid);
    }

    function setWriter(address writer, bool allowed) external onlyOwner {
        writers[writer] = allowed;
        emit WriterUpdated(writer, allowed);
    }

    // ---------- write: access log (from NFC tap) ----------
    function storeAccessLog(
        string calldata vin,
        string calldata uid,
        string calldata state,
        string calldata prevHash,
        string calldata logHash
    ) external onlyWriter {
        require(bytes(vin).length > 0 && bytes(logHash).length == 64, "Invalid input");
        _markHash(logHash);

        bool granted = authorizedKeys[uid];
        accessLogs.push(AccessLog(vin, uid, state, granted, prevHash, logHash, block.timestamp));
        emit AccessLogged(vin, uid, granted, logHash, block.timestamp);
    }

    // ---------- write: odometer proof-of-history ----------
    function storeOdometer(
        string calldata vin,
        uint256 odometerMeters,
        string calldata prevHash,
        string calldata odoHash
    ) external onlyWriter {
        require(bytes(vin).length > 0 && bytes(odoHash).length == 64, "Invalid input");
        require(odometerMeters >= lastOdometerMeters[vin], "Odometer rollback rejected");
        _markHash(odoHash);

        lastOdometerMeters[vin] = odometerMeters;
        odometerRecords.push(OdometerRecord(vin, odometerMeters, prevHash, odoHash, block.timestamp));
        emit OdometerLogged(vin, odometerMeters, odoHash, block.timestamp);
    }

    // Each hash can be stored only once (blocks duplicate / replayed submissions)
    function _markHash(string calldata h) private {
        bytes32 k = keccak256(bytes(h));
        require(!storedHashes[k], "Hash already stored");
        storedHashes[k] = true;
    }

    // ---------- read / verify ----------
    function getAccessLogCount() external view returns (uint256) {
        return accessLogs.length;
    }

    function getOdometerCount() external view returns (uint256) {
        return odometerRecords.length;
    }

    // Verification step: recompute SHA-256 off-chain, then check it exists on-chain
    function isHashStored(string calldata h) external view returns (bool) {
        return storedHashes[keccak256(bytes(h))];
    }

    // Checks that every record's prevHash equals the previous record's hash (same VIN)
    function verifyAccessChain(string calldata vin) external view returns (bool valid, uint256 brokenAt) {
        bytes32 v = keccak256(bytes(vin));
        bytes32 expected;
        bool first = true;
        for (uint256 i = 0; i < accessLogs.length; i++) {
            AccessLog storage l = accessLogs[i];
            if (keccak256(bytes(l.vin)) != v) continue;
            if (!first && keccak256(bytes(l.prevHash)) != expected) return (false, i);
            expected = keccak256(bytes(l.logHash));
            first = false;
        }
        return (true, 0);
    }

    function verifyOdometerChain(string calldata vin) external view returns (bool valid, uint256 brokenAt) {
        bytes32 v = keccak256(bytes(vin));
        bytes32 expected;
        bool first = true;
        for (uint256 i = 0; i < odometerRecords.length; i++) {
            OdometerRecord storage r = odometerRecords[i];
            if (keccak256(bytes(r.vin)) != v) continue;
            if (!first && keccak256(bytes(r.prevHash)) != expected) return (false, i);
            expected = keccak256(bytes(r.odoHash));
            first = false;
        }
        return (true, 0);
    }
}
const hre = require("hardhat");
const crypto = require("crypto");

// Same hash function as sensor.js
const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

async function main() {
  const CONTRACT_ADDRESS = require("fs").readFileSync("deployed-address.txt", "utf8").trim();
  const contract = await hre.ethers.getContractAt("SmartVehicleKey", CONTRACT_ADDRESS);

  const VIN = "SVK1234567890ABCD";
  const GENESIS = "0".repeat(64);

  // Make sure the demo key is registered (deploy.js already does this)
  const uid = "04:A1:B2:C3";
  if (!(await contract.authorizedKeys(uid))) {
    await (await contract.authorizeKey(uid)).wait();
    console.log("🔑 key authorized:", uid);
  }

  // ---------- 1. Access log (NFC tap) ----------
  const logCount = await contract.getAccessLogCount();
  const prevLogHash = logCount > 0n ? (await contract.accessLogs(logCount - 1n)).logHash : GENESIS;

  const state = "IGNITION_OFF";
  const time = new Date().toISOString();
  const logHash = sha256([uid, VIN, time, state, prevLogHash].join("|")); // same formula as sensor.js

  const tx1 = await contract.storeAccessLog(VIN, uid, state, prevLogHash, logHash);
  console.log("⛓️ access log tx sent:", tx1.hash);
  await tx1.wait();
  console.log("✅ access log mined");

  const logIndex = (await contract.getAccessLogCount()) - 1n;
  const log = await contract.accessLogs(logIndex);
  console.log("📄 accessLogs[" + logIndex + "]:", {
    vin: log.vin,
    uid: log.uid,
    state: log.state,
    granted: log.granted,
    logHash: log.logHash,
  });

  // Verify: recompute the hash and check it exists on-chain
  const recomputed = sha256([log.uid, log.vin, time, log.state, log.prevHash].join("|"));
  console.log("🔐 recomputed hash matches stored hash:", recomputed === log.logHash);
  console.log("🔐 isHashStored:", await contract.isHashStored(logHash));

  // ---------- 2. Odometer proof-of-history ----------
  const odoCount = await contract.getOdometerCount();
  const prevOdoHash = odoCount > 0n ? (await contract.odometerRecords(odoCount - 1n)).odoHash : GENESIS;
  const lastMeters = await contract.lastOdometerMeters(VIN);
  const meters = lastMeters === 0n ? 12500059n : lastMeters + 100n; // km x 1000
  const odometerKm = Number(meters) / 1000; // e.g. 12500.059

  const odoTime = new Date().toISOString();
  const odoHash = sha256([VIN, odometerKm, odoTime, prevOdoHash].join("|"));

  const tx2 = await contract.storeOdometer(VIN, meters, prevOdoHash, odoHash);
  console.log("⛓️ odometer tx sent:", tx2.hash);
  await tx2.wait();
  console.log("✅ odometer mined");

  const odo = await contract.odometerRecords((await contract.getOdometerCount()) - 1n);
  console.log("📏 odometer:", Number(odo.odometerMeters) / 1000, "km, hash:", odo.odoHash);

  // ---------- 3. Chain verification ----------
  const [accessValid] = await contract.verifyAccessChain(VIN);
  const [odoValid] = await contract.verifyOdometerChain(VIN);
  console.log("🔗 access chain valid:", accessValid);
  console.log("🔗 odometer chain valid:", odoValid);

  // ---------- 4. Tamper checks ----------
  const fakeHash = "a" + logHash.slice(1);
  console.log("🕵️ altered hash found on-chain (expect false):", await contract.isHashStored(fakeHash));

  try {
    const rollbackHash = sha256("rollback-test-" + Date.now());
    await contract.storeOdometer(VIN, meters - 5000n, odoHash, rollbackHash);
    console.log("❌ rollback was accepted (unexpected)");
  } catch (e) {
    console.log("✅ odometer rollback rejected by the contract");
  }
}

main().catch((e) => {
  console.error("❌ test failed:", e);
  process.exitCode = 1;
});
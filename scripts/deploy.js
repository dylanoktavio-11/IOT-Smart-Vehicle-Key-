const hre = require("hardhat");

async function main() {
  const SmartVehicleKey = await hre.ethers.getContractFactory("SmartVehicleKey");
  const contract = await SmartVehicleKey.deploy();
  await contract.waitForDeployment();

  const addr = await contract.getAddress();
  console.log("SmartVehicleKey deployed to:", addr);

  require("fs").writeFileSync("deployed-address.txt", addr);

  // Register the demo NFC keys (same list as subscriber.js)
  await (await contract.authorizeKey("04:A1:B2:C3")).wait();
  await (await contract.authorizeKey("04:D4:E5:F6")).wait();
  console.log("Demo keys authorized");
}

main().catch((error) => {
  console.error("❌ Deploy failed:", error);
  process.exitCode = 1;
});
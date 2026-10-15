const mqtt = require("mqtt");

const BROKER_URL = "mqtt://broker.hivemq.com";
const VEHICLE_ID = "vehicle-001";

// Change this prefix so it is unique on the public broker (must match subscriber.js)
const BASE_TOPIC = "smart-vehicle-key-demo/vehicle-001";

const client = mqtt.connect(BROKER_URL, {
  connectTimeout: 10_000,
  reconnectPeriod: 2_000,
});

// ---------- helpers ----------
const rand = (min, max) => Math.random() * (max - min) + min;
const chance = (p) => Math.random() < p;
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const round = (obj, d) =>
  Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, Number(v.toFixed(d))]));

// ---------- simulation setup ----------
// The vehicle cycles through these phases so every alert can be demonstrated
const PHASES = [
  { name: "parked", secs: 20 },
  { name: "driving", secs: 50 },
  { name: "parked", secs: 15 },
  { name: "towed", secs: 20 }, // ignition OFF but the car is moving and tilted
];
const CRASH_AT_SECOND = 45; // one simulated collision while driving (null = disabled)

// Last UID is not registered, so it triggers "access denied"
const NFC_TAGS = ["04:A1:B2:C3", "04:A1:B2:C3", "04:D4:E5:F6", "04:99:88:77"];

const sim = {
  lat: -6.2,
  lon: 106.8167,
  speed: 0, // km/h
  heading: 90, // degrees
  crashed: false,
  // Absolute pressure in kPa (about 33 psi gauge)
  tires: { FL: 330, FR: 330, RL: 330, RR: 330 },
};

let phaseIdx = 0;
let phaseStart = Date.now();
let tick = 0;
let crashDone = false;
let started = false;

// ---------- publish ----------
function publish(sub, data) {
  const message = JSON.stringify({
    deviceId: VEHICLE_ID,
    ...data,
    timestamp: new Date().toISOString(),
  });

  client.publish(`${BASE_TOPIC}/${sub}`, message, { qos: 0 }, (err) => {
    if (err) console.error("❌ Publish error:", err.message);
    else console.log(`📤 ${sub.padEnd(6)}`, message);
  });
}

// ---------- sensor models ----------
function updateMotion(phase) {
  if (sim.crashed) {
    sim.speed = 0;
  } else if (phase === "driving") {
    sim.speed = clamp(sim.speed + rand(-8, 10), 20, 60);
    sim.heading = (sim.heading + rand(-12, 12) + 360) % 360;
  } else if (phase === "towed") {
    sim.speed = clamp(sim.speed + rand(-3, 3), 15, 30);
    sim.heading = (sim.heading + rand(-3, 3) + 360) % 360;
  } else {
    sim.speed = 0;
  }

  // Move the GNSS position (1 second per tick)
  const meters = sim.speed / 3.6;
  const rad = (sim.heading * Math.PI) / 180;
  sim.lat += (meters * Math.cos(rad)) / 111_320;
  sim.lon += (meters * Math.sin(rad)) / (111_320 * Math.cos((sim.lat * Math.PI) / 180));
}

// MPU6050: accelerometer in g (rest = 1 g on z), gyroscope in deg/s
function buildImu(phase, crash) {
  const tilt = phase === "towed" ? rand(12, 18) : rand(-1, 1); // front lifted when towed
  const p = (tilt * Math.PI) / 180;
  const accel = { x: Math.sin(p), y: rand(-0.02, 0.02), z: Math.cos(p) };
  const gyro = { x: rand(-2, 2), y: rand(-2, 2), z: rand(-2, 2) };

  if (phase === "driving") {
    for (const k of ["x", "y", "z"]) {
      accel[k] += rand(-0.12, 0.12);
      gyro[k] += rand(-15, 15);
    }
    if (chance(0.04)) accel.z += rand(1.2, 1.8); // pothole / bump
  }

  if (phase === "parked" && chance(0.03)) {
    const shake = () => (chance(0.5) ? 1 : -1) * rand(0.6, 1.0);
    accel.x += shake(); // someone hitting or tampering with the car
    accel.y += shake();
  }

  if (crash) {
    accel.x = -rand(5, 7);
    accel.y = rand(-1.5, 1.5);
    accel.z = rand(1, 2);
    gyro.x = rand(-250, 250);
    gyro.y = rand(-250, 250);
    gyro.z = rand(-250, 250);
  }

  return { accel: round(accel, 3), gyro: round(gyro, 1) };
}

// ---------- main loop (1 second per tick) ----------
function loop() {
  tick++;

  let current = PHASES[phaseIdx];
  if ((Date.now() - phaseStart) / 1000 >= current.secs) {
    phaseIdx = (phaseIdx + 1) % PHASES.length;
    phaseStart = Date.now();
    sim.crashed = false;
    current = PHASES[phaseIdx];
    console.log(`\n🚗 Phase: ${current.name}\n`);
    publish("status", { ignition: current.name === "driving" });
  }
  const phase = current.name;

  const crash =
    CRASH_AT_SECOND && !crashDone && tick >= CRASH_AT_SECOND && phase === "driving";
  if (crash) {
    crashDone = true;
    sim.crashed = true;
  }

  updateMotion(phase);

  // MPU6050 every 1 s
  publish("imu", buildImu(phase, crash));

  // GNSS every 2 s
  if (tick % 2 === 0) {
    publish("gnss", {
      lat: Number(sim.lat.toFixed(6)),
      lon: Number(sim.lon.toFixed(6)),
      speedKmh: Number(sim.speed.toFixed(1)),
      headingDeg: Math.round(sim.heading),
      satellites: Math.floor(rand(8, 14)),
    });
  }

  // PN532 NFC tap, only while parked
  if (phase === "parked" && chance(0.12)) {
    publish("nfc", { reader: "PN532", uid: pick(NFC_TAGS) });
  }

  // TPMS via CAN bus every 5 s (rear-right tire has a slow leak)
  sim.tires.RR = Math.max(200, sim.tires.RR - 0.6);
  if (tick % 5 === 0) {
    const pressureKpa = {};
    for (const [pos, kpa] of Object.entries(sim.tires)) {
      pressureKpa[pos] = Number((kpa + rand(-0.4, 0.4)).toFixed(1));
    }
    publish("tpms", { sensorType: "absolute", pressureKpa });
    publish("status", { ignition: phase === "driving" });
  }
}

client.on("connect", () => {
  console.log("✅ Sensor connected to MQTT broker:", BROKER_URL);
  publish("status", { ignition: false });

  if (started) return; // avoid duplicate timers after a reconnect
  started = true;
  setInterval(loop, 1000);
});

client.on("reconnect", () => console.log("🔄 Reconnecting..."));
client.on("error", (err) => console.error("❌ MQTT error:", err.message));
client.on("close", () => console.log("🔌 Connection closed"));

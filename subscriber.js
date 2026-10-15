const mqtt = require("mqtt");

const BROKER_URL = "mqtt://broker.hivemq.com";
const BASE_TOPIC = "smart-vehicle-key-demo/vehicle-001"; // must match sensor.js

// Key cache on the vehicle (edge check): only these tags may unlock the door
const AUTHORIZED_UIDS = new Set(["04:A1:B2:C3", "04:D4:E5:F6"]);

// Thresholds (adjust to your vehicle spec)
const CRASH_G = 4.0;
const IMPACT_G = 2.0;
const TOW_SPEED_KMH = 5;
const TOW_PITCH_DEG = 10;
const PSI_LOW = 28;
const PSI_CRITICAL = 20;
const ATM_KPA = 101.325;
const KPA_TO_PSI = 0.145038;

const client = mqtt.connect(BROKER_URL, {
  connectTimeout: 10_000,
  reconnectPeriod: 2_000,
});

// Latest known vehicle state, built from all sensor topics
const state = {
  ignition: false,
  lat: null,
  lon: null,
  satellites: null,
  speed: 0,
  heading: 0,
  accelG: 1,
  pitch: 0,
  tires: null,
  tireLevels: {},
  towAlert: false,
  armedUntil: 0,
};

// ---------- helpers ----------
const time = () => new Date().toLocaleTimeString("id-ID");
const compass = (deg) =>
  ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8];
const mapsLink = () => `https://maps.google.com/?q=${state.lat},${state.lon}`;
const notify = (msg) => console.log(`\n🚨 [${time()}] ${msg}\n`);

// ---------- processing logic ----------
function checkTowing() {
  const towing = !state.ignition && state.speed > TOW_SPEED_KMH;

  if (towing && !state.towAlert) {
    state.towAlert = true;
    const lifted = state.pitch > TOW_PITCH_DEG ? `, vehicle tilted ${state.pitch.toFixed(0)}°` : "";
    notify(`TOWING SUSPECTED: moving ${state.speed} km/h with ignition OFF${lifted}. Location: ${mapsLink()}`);
  }
  if (!towing) state.towAlert = false;
}

const handlers = {
  // Ignition state (from CAN bus)
  status(d) {
    state.ignition = Boolean(d.ignition);
    checkTowing();
  },

  // GNSS/GPS
  gnss(d) {
    state.lat = d.lat;
    state.lon = d.lon;
    state.speed = d.speedKmh;
    state.heading = d.headingDeg;
    state.satellites = d.satellites;
    checkTowing();
  },

  // MPU6050 accelerometer & gyroscope
  imu(d) {
    const { x, y, z } = d.accel;
    const g = Math.hypot(x, y, z);
    state.accelG = g;
    state.pitch = (Math.atan2(x, Math.hypot(y, z)) * 180) / Math.PI;

    const armed = Date.now() < state.armedUntil;
    const parkedLimit = armed ? 0.2 : 0.4; // more sensitive after a denied NFC tap

    if (g >= CRASH_G) {
      notify(`CRASH SUSPECTED: impact ${g.toFixed(1)} g. Notify owner and emergency contact. Location: ${mapsLink()}`);
    } else if (g >= IMPACT_G) {
      console.log(`⚠️  [${time()}] Strong shock detected: ${g.toFixed(2)} g`);
    } else if (!state.ignition && Math.abs(g - 1) > parkedLimit) {
      notify(`Unusual vibration while parked (${g.toFixed(2)} g): possible tampering or break-in`);
    }
    checkTowing();
  },

  // PN532 NFC reader (backup physical key)
  nfc(d) {
    if (AUTHORIZED_UIDS.has(d.uid)) {
      console.log(`✅ [${time()}] NFC ${d.uid}: ACCESS GRANTED, door unlocked (backup key)`);
    } else {
      state.armedUntil = Date.now() + 30_000;
      notify(`NFC ${d.uid}: ACCESS DENIED. Warning alert triggered, MPU6050 armed for 30 s, incident flagged`);
    }
  },

  // TPMS via CAN bus (absolute pressure sensor)
  tpms(d) {
    state.tires = {};
    for (const [pos, absKpa] of Object.entries(d.pressureKpa)) {
      const psi = (absKpa - ATM_KPA) * KPA_TO_PSI; // absolute -> gauge pressure
      state.tires[pos] = { kpa: absKpa, psi };

      const level = psi < PSI_CRITICAL ? "CRITICAL" : psi < PSI_LOW ? "LOW" : "OK";
      const previous = state.tireLevels[pos] ?? "OK";
      if (level !== previous) {
        state.tireLevels[pos] = level;
        if (level === "OK") console.log(`✅ [${time()}] Tire ${pos} pressure back to normal`);
        else notify(`Tire ${pos} pressure ${level}: ${psi.toFixed(1)} psi`);
      }
    }
  },
};

// ---------- dashboard (every 5 seconds) ----------
function printDashboard() {
  if (state.lat === null) return; // wait for the first GNSS data

  const tire = (pos) =>
    state.tires?.[pos] ? `${state.tires[pos].psi.toFixed(1)} psi` : "-";

  console.log("\n" + "=".repeat(56));
  console.log(`🚘 SMART VEHICLE KEY DASHBOARD  ${time()}`);
  console.log("=".repeat(56));
  console.log(`🔑 Ignition : ${state.ignition ? "ON" : "OFF"}`);
  console.log(`📍 Location : ${state.lat.toFixed(6)}, ${state.lon.toFixed(6)} (${state.satellites} satellites)`);
  console.log(`🧭 Motion   : ${state.speed} km/h, heading ${state.heading}° ${compass(state.heading)}`);
  console.log(`📳 IMU      : ${state.accelG.toFixed(2)} g, tilt ${state.pitch.toFixed(1)}°`);
  console.log(`🛞 TPMS     : FL ${tire("FL")} | FR ${tire("FR")} | RL ${tire("RL")} | RR ${tire("RR")}`);
  console.log("=".repeat(56));
}
setInterval(printDashboard, 5000);

// ---------- MQTT ----------
client.on("connect", () => {
  console.log("✅ Subscriber connected:", BROKER_URL);

  client.subscribe(`${BASE_TOPIC}/#`, (err) => {
    if (err) console.error("❌ Subscribe error:", err.message);
    else console.log("👂 Listening on topic:", `${BASE_TOPIC}/#`);
  });
});

client.on("message", (topic, message) => {
  const sub = topic.split("/").pop(); // gnss, imu, nfc, tpms, status
  let data;
  try {
    data = JSON.parse(message.toString());
  } catch {
    return console.error("❌ Invalid JSON on", topic);
  }
  handlers[sub]?.(data);
});

client.on("error", (err) => console.error("❌ MQTT error:", err.message));
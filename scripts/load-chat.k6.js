import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  stages: [
    { duration: "1m", target: 50 },   // ramp
    { duration: "3m", target: 200 },  // sustain
    { duration: "1m", target: 0 },    // ramp-down
  ],
};

const TOKEN = __ENV.TEST_PRIVY_TOKEN;
const BASE = __ENV.BASE_URL || "http://localhost:4000";

export default function () {
  const res = http.get(`${BASE}/portfolio`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  check(res, { "status 200": (r) => r.status === 200 });
  sleep(5); // 5s between reqs per VU, mimics user behavior
}

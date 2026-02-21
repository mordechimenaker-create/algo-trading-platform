import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: Number(__ENV.VUS || 10),
  duration: __ENV.DURATION || '30s'
};

const baseUrl = __ENV.BASE_URL || 'http://localhost:3001';

export default function () {
  const health = http.get(`${baseUrl}/health`);
  check(health, {
    'health status 200': (r) => r.status === 200
  });

  const orderbook = http.get(`${baseUrl}/api/orderbook/AAPL`);
  check(orderbook, {
    'orderbook status 200': (r) => r.status === 200
  });

  sleep(1);
}

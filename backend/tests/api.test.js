const { test } = require('node:test');
const assert = require('node:assert/strict');

const BASE_URL = process.env.API_BASE_URL || 'http://localhost:8081';

test('Public statistics API should return HTTP 200', async () => {
    const response = await fetch(`${BASE_URL}/api/public/stats`);

    assert.equal(response.status, 200);
});

test('Statistics API should return all required numeric fields', async () => {
    const response = await fetch(`${BASE_URL}/api/public/stats`);
    const data = await response.json();

    assert.equal(typeof data.titles, 'number');
    assert.equal(typeof data.copies, 'number');
    assert.equal(typeof data.readers, 'number');
    assert.equal(typeof data.loans, 'number');
});

test('Catalogue API should reject unauthenticated requests', async () => {
    const response = await fetch(`${BASE_URL}/api/catalogue`);

    assert.equal(response.status, 401);
});

test('Unknown API endpoint should return HTTP 404', async () => {
    const response = await fetch(`${BASE_URL}/api/invalid-test-route`);

    assert.equal(response.status, 404);
});

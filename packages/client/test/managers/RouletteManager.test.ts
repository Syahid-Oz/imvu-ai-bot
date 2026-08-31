import { Client } from '../../src';

const { IMVU_USERNAME, IMVU_PASSWORD } = process.env;

if (!IMVU_USERNAME || !IMVU_PASSWORD) {
	throw new Error('IMVU_USERNAME and IMVU_PASSWORD are required');
}

describe('RouletteManager.test.ts', () => {
	const client = new Client();

	beforeAll(() => client.login(IMVU_USERNAME, IMVU_PASSWORD, { socket: false }));
	afterAll(() => client.logout());

	it('should fetch the current roulette status', async () => {
		const roulette = client.account.roulette.status();

		await expect(roulette).resolves.toHaveProperty('status');
	});

	it('should spin the wheel if available', async () => {
		const roulette = await client.account.roulette.status();

		const result = await client.account.roulette.spin();

		expect(result).toHaveProperty('status');

		// Spinning a redeemed roulette is a no-op that returns the current status
		if (roulette.status === 'redeemed') {
			expect(result.status).toBe('redeemed');
		}
	});
});

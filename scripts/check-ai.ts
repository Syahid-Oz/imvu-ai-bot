/**
 * AI provider diagnostic.
 *
 * Tests the AI_API_KEY / AI_BASE_URL / AI_MODEL from .env directly against
 * the configured OpenAI-compatible endpoint (no IMVU involved), so you can
 * tell whether a missing chat reply is an AI problem or an IMVU problem.
 *
 * Run with:  npm run check:ai
 */
import { getConfig, hasAi } from '../src/config';

function mask(value: string | undefined): string {
	if (!value) {
		return '(empty)';
	}
	return value.length <= 10 ? `${value.slice(0, 2)}***` : `${value.slice(0, 8)}***${value.slice(-4)}`;
}

async function main(): Promise<void> {
	const config = getConfig();

	console.log('--- AI provider check ---');
	console.log(`Base URL : ${config.aiBaseUrl}`);
	console.log(`Model    : ${config.aiModel}`);
	console.log(`API key  : ${mask(config.aiApiKey)}`);

	if (!hasAi(config)) {
		console.error('\n[FAIL] AI_API_KEY is empty in .env - paste your provider key there.');
		process.exit(1);
	}

	// OpenRouter: show the key's quota / rate-limit state (free-tier limits
	// are the most common cause of 429 errors on ":free" models).
	if (config.aiBaseUrl.includes('openrouter.ai')) {
		try {
			const auth = await fetch(`${config.aiBaseUrl}/auth/key`, {
				headers: { authorization: `Bearer ${config.aiApiKey}` },
			});
			const authJson: any = await auth.json();
			const data = authJson?.data ?? {};
			console.log(
				`\nOpenRouter key: limit=${data.limit ?? 'n/a'} used=${data.usage ?? 'n/a'} ` +
					`free_tier=${data.is_free_tier ?? 'n/a'} rate_limit=${JSON.stringify(data.rate_limit ?? {})}`
			);
			if (!auth.ok) {
				console.error(`[FAIL] OpenRouter rejected the key (${auth.status}):`, JSON.stringify(authJson).slice(0, 300));
				process.exit(1);
			}
		} catch (error) {
			console.error('[FAIL] Could not reach OpenRouter:', String(error));
			process.exit(1);
		}
	}

	console.log('\nSending test chat completion request...');
	const started = Date.now();

	try {
		const response = await fetch(`${config.aiBaseUrl}/chat/completions`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${config.aiApiKey}`,
			},
			body: JSON.stringify({
				model: config.aiModel,
				max_tokens: 100,
				temperature: 0.8,
				messages: [
					{ role: 'system', content: 'You are a test assistant. Reply in one short sentence.' },
					{ role: 'user', content: 'Say hello.' },
				],
			}),
		});

		const json: any = await response.json();
		const ms = Date.now() - started;

		if (!response.ok) {
			console.error(`[FAIL] Provider returned HTTP ${response.status} after ${ms}ms:`);
			console.error(JSON.stringify(json, null, 2).slice(0, 1000));
			process.exit(1);
		}

		const content = json?.choices?.[0]?.message?.content?.trim();
		console.log(`[OK] Provider responded in ${ms}ms:`);
		console.log(`"${content}"`);
		console.log('\nThe AI provider works. If IMVU still shows nothing, the issue is on the IMVU/chat side.');
	} catch (error) {
		console.error('[FAIL] Network error contacting the AI provider:', String(error));
		process.exit(1);
	}
}

void main();

/**
 * DEPRECATED entry point.
 *
 * The bot was restructured into modular files without changing the existing
 * AI system:
 *
 *   src/index.ts   - startup orchestration, status panel, commands
 *   src/config.ts  - single configuration source (.env)
 *   src/imvu/auth.ts - IMVU account authentication (@imvu/client)
 *   src/imvu/room.ts - IMQ realtime connection + room join (@imvu/imq)
 *   src/imvu/chat.ts - room chat receive/send
 *   src/ai/ai.ts   - the existing AI system (moved here VERBATIM)
 *
 * Run the bot with:  npm start
 */
import '../src/index';

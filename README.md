# IMVU AI Bot 🤖

[![Build Packages](https://github.com/dhkatz/imvu.js/actions/workflows/build.yml/badge.svg)](https://github.com/dhkatz/imvu.js/actions/workflows/build.yml)

A JavaScript/TypeScript AI-powered bot for IMVU that automatically replies to room chat messages, inbox messages, and auto-accepts friend requests. Built on top of the `@imvu` monorepo libraries.

## ✨ Features

- **🤖 AI Room Chat** - Auto-replies to room messages that mention the bot's name
- **📨 Inbox Auto-Reply** - Automatically replies to private/inbox messages using AI
- **👥 Auto-Accept Friends** - Automatically accepts incoming friend requests
- **🟢 24/7 Keep-Alive** - Stays online with automatic reconnection
- **🧠 AI Memory** - Remembers conversation context per user
- **👋 Welcome Messages** - Greets new users joining the room
- **🎭 Customizable** - Full control over bot personality, name, and behavior

## 🚀 Quick Start

### 1. Install

```bash
npm install
```

### 2. Configure

Copy the example environment file and edit it:

```bash
cp .env.example .env
```

Edit `.env` with your values:

```env
# Required: Your IMVU account credentials
IMVU_USERNAME=your_bot_username
IMVU_PASSWORD=your_bot_password

# Required: The room the bot will join
IMVU_ROOM_ID=123456789

# Required: AI API (OpenRouter free key works!)
AI_API_KEY=your_openrouter_api_key
AI_BASE_URL=https://openrouter.ai/api/v1
AI_MODEL=minimax/minimax-m3:free

# Bot personality & name
AI_PERSONA=a friendly and helpful IMVU assistant
BOT_NAME=Bot_Name

# Owner info (users can contact if bot doesn't understand)
OWNER_NAME=IMVU_UserID

# Auto features
AUTO_REPLY_INBOX=true
AUTO_ACCEPT_FRIENDS=true
```

### 3. Run

```bash
npm start
```

## ⚙️ Configuration Reference

### Required Settings

| Variable | Description | Example |
|----------|-------------|---------|
| `IMVU_USERNAME` | Your bot's IMVU username | `mybot` |
| `IMVU_PASSWORD` | Your bot's IMVU password | `password123` |
| `IMVU_ROOM_ID` | Room ID to join | `123456789` or `123456789-12` |
| `AI_API_KEY` | AI provider API key | `sk-or-...` |
| `AI_BASE_URL` | AI API base URL | `https://openrouter.ai/api/v1` |
| `AI_MODEL` | AI model name | `minimax/minimax-m3:free` |

### Optional Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `IMVU_2FA_CODE` | *(none)* | 2FA code if account has 2FA |
| `AI_PERSONA` | `a friendly and helpful IMVU assistant` | Bot's personality description |
| `BOT_NAME` | `BotName` | Name users must mention to trigger reply |
| `OWNER_NAME` | `AdminName` | Owner name for user support |
| `OWNER_ID` | *(none)* | Owner's IMVU user ID |
| `AUTO_REPLY_INBOX` | `true` | Auto-reply to private messages |
| `AUTO_ACCEPT_FRIENDS` | `true` | Auto-accept friend requests |

### AI Provider Options

#### Option A: OpenRouter (free)
```
AI_API_KEY=your_openrouter_key
AI_BASE_URL=https://openrouter.ai/api/v1
AI_MODEL=minimax/minimax-m3:free
```

#### Option B: NVIDIA NIM (free 1000 credits)
```
AI_API_KEY=your_nvidia_key
AI_BASE_URL=https://integrate.api.nvidia.com/v1
AI_MODEL=nvidia/llama-3.1-nemotron-70b-instruct
```

#### Option C: OpenAI
```
AI_API_KEY=your_openai_key
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-4o-mini
```
## 📦 Project Structure

```
src/
  index.ts              # Main entry point
  config.ts             # Configuration (reads .env)
  ai/
    ai.ts               # AI chat system
  imvu/
    auth.ts             # IMVU authentication
    room.ts             # IMQ realtime connection
    chat.ts             # Room chat handling
    messages.ts         # Private/inbox message handling
    friendRequests.ts   # Friend request auto-accept
scripts/
  check-ai.ts           # AI provider test script
  room-listen.ts        # Room diagnostic script
packages/
  client/               # @imvu/client - IMVU API client
  imq/                  # @imvu/imq - IMQ websocket client
```

## 🎮 Commands

While the bot is running, you can use these commands:

| Command | Description |
|---------|-------------|
| `/status` | Show connection status panel |
| `/say <text>` | Send a raw message to the room |
| `/test` | Test the AI reply pipeline |
| `/help` | Show available commands |
| `/logout` | Logout and return to login state |
| `/exit` | Shutdown the bot |

## 📝 How It Works

### Room Chat
1. Bot joins the configured IMVU room
2. Listens for messages that mention the bot's name (e.g., "hey bot_name")
3. Sends the message to the configured AI provider
4. Replies with the AI-generated response in the room

### Inbox / Private Messages
1. When `AUTO_REPLY_INBOX=true`, the bot listens for private messages
2. Any private message received triggers an AI reply
3. The reply is sent back as a private message to the sender

### Friend Requests
1. When `AUTO_ACCEPT_FRIENDS=true`, the bot periodically checks for new friends
2. Any new friend is automatically accepted
3. Works with the `FriendManager` from `@imvu/client`

### Keep-Alive
1. The bot monitors the room connection status
2. If disconnected, it automatically attempts to reconnect
3. Reconnection uses the same IMQ session cookie for seamless reconnection

## 🔒 Security

- **Never commit `.env`** - It's already in `.gitignore`
- API keys are sent ONLY to the AI provider, never to IMVU
- Session cookies are stored in `cookies.json` (git-ignored)
- No credentials or tokens are logged to console

## 🧪 Testing

### Test AI Provider
```bash
npm run check:ai
```

### Test Room Connection
```bash
npm run check:room
```

## 👤 Owner Configuration

If the bot doesn't understand something or users need help, it can redirect them to the owner. Configure these in `.env`:

```env
OWNER_NAME=             # Your IMVU username
OWNER_ID=               # Your IMVU user ID (optional)
```

The bot's AI persona includes owner information so it knows who to direct users to when needed.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Credits

- Built on [@imvu](https://github.com/dhkatz/imvu.js) libraries by David Katz
- AI integration supports OpenAI, OpenRouter, NVIDIA NIM, and any OpenAI-compatible API

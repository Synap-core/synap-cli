# Installation Guide

Everything you need to run `synap` on any machine.

---

## Quick summary

| You need | Why |
|----------|-----|
| **Node.js 20+** | The CLI runs on Node |
| **npm 9+** | Comes with Node, used to install the CLI |
| **OpenClaw** | The AI agent framework Synap connects to |
| **Docker** *(optional)* | Only if you're self-hosting a Synap pod |

---

## 1. Install Node.js

### macOS

Use [nvm](https://github.com/nvm-sh/nvm) (recommended — avoids permission issues with global packages):

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
# restart your terminal, then:
nvm install 20
nvm use 20
node --version   # should print v20.x.x
```

Or install directly from [nodejs.org](https://nodejs.org) (LTS).

### Linux (Ubuntu / Debian)

```bash
# NodeSource repo — always up to date
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version
```

### Linux (RHEL / CentOS / Amazon Linux)

```bash
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo yum install -y nodejs
node --version
```

### Linux — via nvm (no sudo required, best for servers)

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc   # or ~/.zshrc
nvm install 20
nvm alias default 20
node --version
```

With nvm, global `npm install -g` installs to your home directory — no `sudo` needed.

### Windows

Download the LTS installer from [nodejs.org](https://nodejs.org). After install, open a new terminal and verify:

```powershell
node --version
npm --version
```

> On Windows, prefer [Windows Terminal](https://aka.ms/terminal) or WSL2 (Ubuntu) for the best experience.

---

## 2. Install the Synap CLI

```bash
npm install -g @synap-core/cli
synap --version
```

**Getting a permission error on Linux/macOS?**

If you installed Node via the system package manager (not nvm), global installs may need sudo — but that's a bad practice. Fix it properly:

```bash
# Option A — use nvm (recommended, see above)

# Option B — change npm's global prefix to your home dir
mkdir -p ~/.npm-global
npm config set prefix '~/.npm-global'
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
source ~/.bashrc
npm install -g @synap-core/cli
```

**Verify the install:**

```bash
synap --version     # 0.9.0
synap --help
```

---

## 3. Install OpenClaw

OpenClaw is the AI agent framework the Synap skill plugs into.

```bash
npm install -g openclaw
openclaw --version
```

Start the gateway:

```bash
openclaw start
# Gateway runs on http://localhost:18789 by default
```

Verify it's running:

```bash
openclaw status
# or
curl http://localhost:18789/health
```

> If you're on a remote server, OpenClaw should bind to `127.0.0.1` only (not `0.0.0.0`). This is the default and the security audit will flag it if misconfigured.

---

## 4. Run the setup wizard

```bash
synap init
```

That's it. The wizard detects OpenClaw, connects to your pod, installs the skill, and seeds the workspace.

---

## Platform-specific notes

### Remote Linux server (SSH, no browser)

The default `synap login` opens a browser — that won't work over SSH. Use token login instead:

1. Go to [synap.live/account/tokens](https://synap.live/account/tokens) in your local browser
2. Generate a token
3. On the server:
   ```bash
   synap login --token <your-token>
   synap init
   ```

### Server running as a systemd service / Docker

If OpenClaw runs as a service, make sure the Synap skill is installed before starting it:

```bash
# Install the skill first
synap init   # completes skill install + workspace seed

# Then start OpenClaw as a service
systemctl start openclaw
# or
docker compose up -d openclaw
```

The skill is read from disk on OpenClaw startup — no restart needed after `synap update` if OpenClaw reloads skills dynamically.

### Running OpenClaw in Docker (self-hosted full stack)

If you use the Synap Docker Compose stack, OpenClaw runs as a container alongside the pod:

```bash
git clone https://github.com/synap-core/synap-backend
cd synap-backend
cp deploy/.env.example deploy/.env
# edit deploy/.env — set POSTGRES_PASSWORD, DOMAIN, etc. (no AI key needed here)

docker compose --profile openclaw up -d
```

Then connect and finish the setup:

```bash
synap init
# → "I already have an existing pod"
# → Pod URL: http://localhost:4000

synap finish
# → installs skill, prompts for AI key, offers public domain
```

The AI provider key is set via OpenClaw's own config (`openclaw config set env.ANTHROPIC_API_KEY …`) — not via the `.env` file. `synap finish` handles this for you.

### macOS — running on a Mac Mini / always-on machine

OpenClaw can run as a launchd service:

```bash
openclaw service install   # installs and enables launchd plist
openclaw service start
openclaw service status
```

Then `synap init` connects to it as normal.

---

## Keeping things up to date

```bash
# Update the CLI
npm update -g @synap-core/cli

# Update the Synap skill inside OpenClaw
synap update

# Check everything is healthy
synap status
```

---

## Uninstall

```bash
npm uninstall -g @synap-core/cli
rm -rf ~/.synap        # removes stored credentials + pod config
```

To also remove the skill from OpenClaw:

```bash
openclaw skills remove synap
```

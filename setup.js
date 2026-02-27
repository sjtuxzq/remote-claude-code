import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, ".env");
const envExamplePath = path.join(__dirname, ".env.example");
const isWindows = process.platform === "win32";

function run(cmd, label) {
  console.log(`\n▶ ${label}...`);
  try {
    execSync(cmd, { stdio: "inherit", cwd: __dirname });
    return true;
  } catch {
    console.error(`✗ Failed: ${label}`);
    return false;
  }
}

function isInstalled(cmd) {
  try {
    execSync(isWindows ? `where ${cmd}` : `which ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function configureEnv(rl) {
  if (fs.existsSync(envPath)) {
    const overwrite = await ask(rl, "\n.env already exists. Overwrite? (y/N): ");
    if (overwrite.toLowerCase() !== "y") {
      console.log("Keeping existing .env");
      return;
    }
  }

  console.log("\n📝 Configure environment variables:\n");

  const vars = [];

  // Required
  const botToken = await ask(rl, "BOT_TOKEN (Telegram bot token, required): ");
  if (!botToken.trim()) {
    console.error("✗ BOT_TOKEN is required. Aborting.");
    process.exit(1);
  }
  vars.push(`BOT_TOKEN=${botToken.trim()}`);

  const userIds = await ask(rl, "ALLOWED_USER_IDS (comma-separated Telegram user IDs, required): ");
  if (!userIds.trim()) {
    console.error("✗ ALLOWED_USER_IDS is required. Aborting.");
    process.exit(1);
  }
  vars.push(`ALLOWED_USER_IDS=${userIds.trim()}`);

  // Optional
  const chatIds = await ask(rl, "ALLOWED_CHAT_IDS (comma-separated, Enter to skip): ");
  vars.push(`ALLOWED_CHAT_IDS=${chatIds.trim()}`);

  const paths = await ask(rl, "ALLOWED_PATHS (comma-separated parent dirs, Enter to skip): ");
  vars.push(`ALLOWED_PATHS=${paths.trim()}`);

  const dataDir = await ask(rl, "DATA_DIR (default: ./data, Enter to skip): ");
  vars.push(`DATA_DIR=${dataDir.trim() || "./data"}`);

  const maxTurns = await ask(rl, "MAX_TURNS_PER_MESSAGE (Enter to skip): ");
  vars.push(`MAX_TURNS_PER_MESSAGE=${maxTurns.trim()}`);

  const maxBudget = await ask(rl, "MAX_BUDGET_PER_MESSAGE (Enter to skip): ");
  vars.push(`MAX_BUDGET_PER_MESSAGE=${maxBudget.trim()}`);

  fs.writeFileSync(envPath, vars.join("\n") + "\n");
  console.log("✓ .env created");
}

async function main() {
  console.log("🚀 remote-cc setup\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    // 1. npm install
    if (!run("npm install", "Installing dependencies")) {
      process.exit(1);
    }

    // 2. Configure .env
    await configureEnv(rl);

    // 3. Build
    if (!run("npm run build", "Building TypeScript")) {
      process.exit(1);
    }

    // 4. PM2 setup
    console.log("\n📦 Setting up PM2...");

    if (!isInstalled("pm2")) {
      console.log("PM2 not found, installing globally...");
      if (!run("npm install -g pm2", "Installing PM2")) {
        console.error("✗ Failed to install PM2. You can install it manually: npm install -g pm2");
        process.exit(1);
      }
    }

    // Check if remote-cc is already registered in PM2
    try {
      const pm2List = execSync("pm2 jlist", { encoding: "utf-8" });
      const apps = JSON.parse(pm2List);
      const existing = apps.find((a) => a.name === "remote-cc");
      if (existing) {
        console.log("remote-cc already registered in PM2, restarting...");
        run("pm2 restart remote-cc", "Restarting remote-cc");
      } else {
        run("pm2 start dist/index.js --name remote-cc", "Registering with PM2");
      }
    } catch {
      run("pm2 start dist/index.js --name remote-cc", "Registering with PM2");
    }

    run("pm2 save", "Saving PM2 process list");

    // Auto-start on boot
    if (isWindows) {
      if (!isInstalled("pm2-startup")) {
        console.log("\nInstalling pm2-windows-startup for auto-start on boot...");
        run("npm install -g pm2-windows-startup", "Installing pm2-windows-startup");
      }
      run("pm2-startup install", "Configuring auto-start");
    } else {
      console.log("\n▶ Configuring auto-start...");
      try {
        const output = execSync("pm2 startup", { encoding: "utf-8" });
        console.log(output);
        if (output.includes("sudo")) {
          console.log("⚠️  Run the sudo command above to enable auto-start on boot.");
        }
      } catch {
        console.log("⚠️  Run 'pm2 startup' manually to enable auto-start on boot.");
      }
    }

    console.log("\n✅ Setup complete! remote-cc is running.");
    console.log("   Logs: pm2 logs remote-cc");
    console.log("   Status: pm2 list");
  } finally {
    rl.close();
  }
}

main();

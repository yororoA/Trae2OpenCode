const translations = {
  zh: {
    "a11y.skip": "跳到主要内容",
    "nav.why": "为什么",
    "nav.demo": "迁移演示",
    "nav.capabilities": "能力",
    "nav.quickstart": "开始使用",
    "hero.eyebrow": "macOS / Windows · OpenCode v1 / v2",
    "hero.statement": "把 TRAE 会话，完整带到 OpenCode。",
    "hero.description": "一条命令迁移消息、推理与工具调用。自动发现并可同时迁移到 OpenCode v1/v2，支持中断续跑，并在每个目标写入后逐项回读核验。",
    "hero.start": "在 GitHub 获取",
    "hero.source": "查看使用方式",
    "proof.command": "条命令完成迁移",
    "proof.platforms": "本机 TRAE 来源读取",
    "proof.protocols": "v1/v2 可同时迁移",
    "proof.readback": "写入后逐项核验",
    "why.eyebrow": "不是复制粘贴",
    "why.title": "迁移的是可以继续工作的上下文",
    "why.sourceLabel": "TRAE 中的原始会话",
    "why.sourceText": "消息、推理、命令、状态与时间关系相互交织。",
    "why.core": "规范化 · 脱敏 · 映射",
    "why.targetLabel": "OpenCode 原生时间线",
    "why.targetText": "保持顺序和语义，并对目标结果逐项回读。",
    "demo.eyebrow": "交互演示",
    "demo.title": "选择会话，其余交给迁移器",
    "demo.copy": "无需寻找 workbench ID 或 session ID。多选、覆盖保护、续跑与核验都在同一流程中完成。",
    "demo.ready": "等待选择",
    "demo.sessions": "可迁移会话",
    "demo.sessionOne": "修复迁移流程",
    "demo.sessionTwo": "保留工具调用",
    "demo.sessionThree": "发布前检查",
    "demo.terminalReady": "选择会话后开始迁移。",
    "demo.run": "运行演示",
    "demo.running": "迁移中",
    "demo.done": "核验完成",
    "demo.rerun": "重新演示",
    "demo.none": "请至少选择一个会话。",
    "capabilities.eyebrow": "迁移不靠运气",
    "capabilities.title": "每一步都有明确证据",
    "capabilities.fidelityTitle": "保留过程",
    "capabilities.fidelityText": "Assistant 过程文本、reasoning 与工具调用按原顺序进入 OpenCode 原生时间线。",
    "capabilities.safetyTitle": "默认保护",
    "capabilities.safetyText": "自动剥离已识别凭据；目标归属、协议兼容性或完整性验证失败时都会停止。",
    "capabilities.resumeTitle": "可以续跑",
    "capabilities.resumeText": "Manifest 记录每个阶段。中断后从可靠检查点继续，不重复导入已验证内容。",
    "trust.eyebrow": "默认拒绝猜测",
    "trust.title": "看不懂的数据，不猜。<br>无法验证的目标，不写。",
    "trust.itemOne": "稳定身份与所有权标记",
    "trust.itemTwo": "Schema、快照与完整 hash",
    "trust.itemThree": "导入后逐消息回读对账",
    "quickstart.eyebrow": "快速开始",
    "quickstart.title": "准备好两个应用，然后运行一条命令",
    "quickstart.stepOneTitle": "安装依赖",
    "quickstart.stepOneText": "克隆仓库，并使用 Node.js 18.18 或更高版本。",
    "quickstart.stepTwoTitle": "启动 TRAE 调试端口",
    "quickstart.stepTwoText": "在 macOS 或 Windows 上用调试参数启动 TRAE，并打开目标项目窗口。",
    "quickstart.stepThreeTitle": "运行迁移",
    "quickstart.stepThreeText": "按列表选择会话，等待回读核验完成。",
    "quickstart.terminal": "终端",
    "quickstart.manual": "阅读完整操作手册",
    "compatibility.eyebrow": "明确的兼容边界",
    "compatibility.title": "兼容性，由实际验证决定",
    "compatibility.component": "组件",
    "compatibility.supported": "验证基线 / 要求",
    "compatibility.behavior": "其他情况",
    "compatibility.reject": "拒绝写入",
    "compatibility.probeV2": "其他稳定 2.x 自动检测",
    "compatibility.probeV1": "其他稳定 1.x 自动检测",
    "compatibility.upgrade": "提示升级",
    "compatibility.platform": "本机来源读取",
    "compatibility.offline": "Linux 仅导入 bundle",
    "compatibility.note": "表中版本为已验证基线；其他稳定 1.x/2.x 需使用同版本 CLI 并通过隔离验证。双目标迁移要求两个 CLI 和彼此独立的数据库。",
    "cta.eyebrow": "上下文不该被困在一个工具里",
    "cta.copy": "保留过程，验证结果，然后从原来的地方继续工作。",
    "cta.github": "在 GitHub 获取",
    "cta.guide": "查看使用方式",
    "footer.copy": "开放源码的 TRAE 会话迁移工具。",
    "footer.readme": "项目说明",
    "footer.help": "故障排查",
    "footer.license": "ISC 许可证",
  },
  en: {
    "a11y.skip": "Skip to main content",
    "nav.why": "Why",
    "nav.demo": "Live demo",
    "nav.capabilities": "Capabilities",
    "nav.quickstart": "Get started",
    "hero.eyebrow": "macOS / Windows · OpenCode v1 / v2",
    "hero.statement": "Bring your TRAE sessions to OpenCode, intact.",
    "hero.description": "Migrate messages, reasoning, and tool calls with one command. OpenCode v1 and v2 targets can be discovered and migrated together, interrupted runs resume safely, and every target is verified after writing.",
    "hero.start": "Get it on GitHub",
    "hero.source": "See how it works",
    "proof.command": "command to migrate",
    "proof.platforms": "local TRAE source support",
    "proof.protocols": "v1/v2 targets in one run",
    "proof.readback": "verification after every write",
    "why.eyebrow": "More than copy and paste",
    "why.title": "Move context you can keep working with",
    "why.sourceLabel": "Original TRAE session",
    "why.sourceText": "Messages, reasoning, commands, states, and timing are intertwined.",
    "why.core": "Normalize · Redact · Map",
    "why.targetLabel": "Native OpenCode timeline",
    "why.targetText": "Preserve order and meaning, then reconcile the target result.",
    "demo.eyebrow": "Interactive demo",
    "demo.title": "Choose sessions. Let the migrator handle the rest.",
    "demo.copy": "No workbench IDs or session IDs to find. Selection, overwrite protection, resume, and verification happen in one flow.",
    "demo.ready": "Ready",
    "demo.sessions": "Available sessions",
    "demo.sessionOne": "Fix migration flow",
    "demo.sessionTwo": "Preserve tool calls",
    "demo.sessionThree": "Pre-release checks",
    "demo.terminalReady": "Select sessions, then start the migration.",
    "demo.run": "Run demo",
    "demo.running": "Migrating",
    "demo.done": "Verified",
    "demo.rerun": "Run again",
    "demo.none": "Select at least one session.",
    "capabilities.eyebrow": "Migration without guesswork",
    "capabilities.title": "Every step leaves evidence",
    "capabilities.fidelityTitle": "Keep the process",
    "capabilities.fidelityText": "Assistant progress, reasoning, and tool calls land in the native OpenCode timeline in source order.",
    "capabilities.safetyTitle": "Protect by default",
    "capabilities.safetyText": "Detected secrets are removed. Failed ownership, protocol compatibility, or integrity checks stop migration.",
    "capabilities.resumeTitle": "Resume safely",
    "capabilities.resumeText": "A manifest records each stage, so interrupted runs continue from durable checkpoints without duplicate imports.",
    "trust.eyebrow": "Fail closed",
    "trust.title": "Unknown data is not guessed.<br>Unverified targets are not written.",
    "trust.itemOne": "Stable identity and ownership markers",
    "trust.itemTwo": "Schema, snapshot, and complete hash",
    "trust.itemThree": "Message-level readback reconciliation",
    "quickstart.eyebrow": "Quick start",
    "quickstart.title": "Prepare both apps, then run one command",
    "quickstart.stepOneTitle": "Install dependencies",
    "quickstart.stepOneText": "Clone the repository and use Node.js 18.18 or newer.",
    "quickstart.stepTwoTitle": "Start TRAE with debugging",
    "quickstart.stepTwoText": "Start TRAE with debugging on macOS or Windows, then open the target project window.",
    "quickstart.stepThreeTitle": "Run the migration",
    "quickstart.stepThreeText": "Select sessions from the list and wait for readback verification.",
    "quickstart.terminal": "Terminal",
    "quickstart.manual": "Read the full operation guide",
    "compatibility.eyebrow": "Explicit compatibility",
    "compatibility.title": "Compatibility is verified at runtime",
    "compatibility.component": "Component",
    "compatibility.supported": "Baseline / requirement",
    "compatibility.behavior": "Other cases",
    "compatibility.reject": "Write rejected",
    "compatibility.probeV2": "Other stable 2.x releases are checked",
    "compatibility.probeV1": "Other stable 1.x releases are checked",
    "compatibility.upgrade": "Upgrade required",
    "compatibility.platform": "Local source access",
    "compatibility.offline": "Linux imports bundles only",
    "compatibility.note": "Listed versions are verified baselines. Other stable 1.x/2.x releases need a matching CLI and isolated verification. Dual-target migration requires both CLIs and separate databases.",
    "cta.eyebrow": "Context should not be trapped in one tool",
    "cta.copy": "Keep the process, verify the result, and continue where you left off.",
    "cta.github": "Get it on GitHub",
    "cta.guide": "See how it works",
    "footer.copy": "An open-source TRAE session migration tool.",
    "footer.readme": "README",
    "footer.help": "Troubleshooting",
    "footer.license": "ISC License",
  },
};

const platformCommands = {
  macos: `"/Applications/Trae CN.app/Contents/MacOS/Electron" \\
  --remote-debugging-address=127.0.0.1 \\
  --remote-debugging-port=9222

npm run migrate:local`,
  windows: `& "$env:LOCALAPPDATA\\Programs\\Trae CN\\Trae CN.exe" \`
  --remote-debugging-address=127.0.0.1 \`
  --remote-debugging-port=9222

npm run migrate:local`,
  linux: `npm ci
npm run build
node dist/cli/index.js migrate \\
  --input ./migration-bundle.json \\
  --dry-run \\
  --server http://127.0.0.1:4096`,
};

const demoLines = {
  zh: [
    { text: "已连接 TRAE CN 3.3.104 · CDP 127.0.0.1:9222", kind: "muted" },
    { text: "✓ 发现 2 个已选择会话", kind: "success" },
    { text: "✓ 已生成独立 bundle，并完成凭据检查", kind: "success" },
    { text: "→ 映射消息、reasoning 与 shell 工具", kind: "note" },
    { text: "✓ OpenCode 1.18.32 · v1 协议与 schema 已验证", kind: "success" },
    { text: "✓ 导入完成：逐消息回读一致", kind: "success" },
    { text: "迁移完成，可以在 OpenCode 中继续对话。", kind: "success" },
  ],
  en: [
    { text: "Connected to TRAE CN 3.3.104 · CDP 127.0.0.1:9222", kind: "muted" },
    { text: "✓ Found 2 selected sessions", kind: "success" },
    { text: "✓ Created isolated bundles and checked credentials", kind: "success" },
    { text: "→ Mapping messages, reasoning, and shell tools", kind: "note" },
    { text: "✓ OpenCode 1.18.32 · v1 protocol and schema verified", kind: "success" },
    { text: "✓ Import complete: message-level readback matched", kind: "success" },
    { text: "Migration complete. Continue in OpenCode.", kind: "success" },
  ],
};

function readSavedLanguage() {
  try {
    return localStorage.getItem("t2o-language");
  } catch {
    return null;
  }
}

function saveLanguage(language) {
  try {
    localStorage.setItem("t2o-language", language);
  } catch {
    // File previews and privacy modes may not expose persistent storage.
  }
}

const state = {
  language: readSavedLanguage() ||
    (navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en"),
  platform: "macos",
  demoTimer: undefined,
  demoRunning: false,
};

function applyLanguage(language) {
  const next = translations[language] ? language : "zh";
  state.language = next;
  document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
  saveLanguage(next);

  document.querySelectorAll("[data-i18n]").forEach((element) => {
    const key = element.dataset.i18n;
    const value = translations[next][key];
    if (!value) return;
    if (key === "trust.title") element.innerHTML = value;
    else element.textContent = value;
  });

  document.querySelectorAll("[data-lang]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.lang === next));
  });

  document.title = next === "zh"
    ? "Trae2OpenCode | 可验证的会话迁移"
    : "Trae2OpenCode | Verifiable session migration";
}

function applyPlatform(platform) {
  if (!platformCommands[platform]) return;
  state.platform = platform;
  document.querySelector("[data-platform-command] code").textContent = platformCommands[platform];
  document.querySelectorAll("[data-platform]").forEach((button) => {
    button.setAttribute("aria-selected", String(button.dataset.platform === platform));
  });
}

function setCopyFeedback(button, copied) {
  const label = state.language === "zh"
    ? copied ? "已复制" : "复制"
    : copied ? "Copied" : "Copy";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.innerHTML = `<i data-lucide="${copied ? "check" : "copy"}" aria-hidden="true"></i>`;
  window.lucide?.createIcons();
}

async function copyText(button) {
  const target = button.dataset.copyTarget
    ? document.getElementById(button.dataset.copyTarget)?.textContent
    : button.dataset.copy;
  if (!target) return;

  try {
    await navigator.clipboard.writeText(target.trim());
    setCopyFeedback(button, true);
    window.setTimeout(() => setCopyFeedback(button, false), 1600);
  } catch {
    setCopyFeedback(button, false);
  }
}

function resetDemo() {
  window.clearTimeout(state.demoTimer);
  state.demoRunning = false;
  const output = document.querySelector("[data-terminal-output]");
  const progress = document.querySelector("[data-progress]");
  const status = document.querySelector("[data-demo-status]");
  const button = document.querySelector("[data-run-demo]");
  output.innerHTML = `<p><span class="terminal-prompt">$</span> npm run migrate:local</p>
    <p class="terminal-muted">${translations[state.language]["demo.terminalReady"]}</p>`;
  progress.style.width = "0";
  status.textContent = translations[state.language]["demo.ready"];
  button.disabled = false;
  button.innerHTML = `<i data-lucide="play" aria-hidden="true"></i>
    <span>${translations[state.language]["demo.run"]}</span>`;
  window.lucide?.createIcons();
}

function runDemo() {
  if (state.demoRunning) return;
  const selected = [...document.querySelectorAll(".session-row input:checked")];
  const output = document.querySelector("[data-terminal-output]");
  const progress = document.querySelector("[data-progress]");
  const status = document.querySelector("[data-demo-status]");
  const button = document.querySelector("[data-run-demo]");

  if (selected.length === 0) {
    output.innerHTML = `<p><span class="terminal-prompt">$</span> npm run migrate:local</p>
      <p class="terminal-note">${translations[state.language]["demo.none"]}</p>`;
    return;
  }

  state.demoRunning = true;
  button.disabled = true;
  button.innerHTML = `<i data-lucide="loader-circle" aria-hidden="true"></i>
    <span>${translations[state.language]["demo.running"]}</span>`;
  status.textContent = translations[state.language]["demo.running"];
  output.innerHTML = '<p><span class="terminal-prompt">$</span> npm run migrate:local</p>';
  progress.style.width = "5%";
  window.lucide?.createIcons();

  const lines = demoLines[state.language];
  let index = 0;
  const appendNext = () => {
    const line = lines[index];
    const paragraph = document.createElement("p");
    paragraph.className = line.kind === "success"
      ? "terminal-success"
      : line.kind === "note" ? "terminal-note" : "terminal-muted";
    paragraph.textContent = line.text.replace("2 selected", `${selected.length} selected`)
      .replace("2 个已选择", `${selected.length} 个已选择`);
    output.append(paragraph);
    output.scrollTop = output.scrollHeight;
    index += 1;
    progress.style.width = `${Math.round((index / lines.length) * 100)}%`;

    if (index < lines.length) {
      state.demoTimer = window.setTimeout(appendNext, 520);
      return;
    }

    state.demoRunning = false;
    button.disabled = false;
    status.textContent = translations[state.language]["demo.done"];
    button.innerHTML = `<i data-lucide="rotate-ccw" aria-hidden="true"></i>
      <span>${translations[state.language]["demo.rerun"]}</span>`;
    window.lucide?.createIcons();
  };

  state.demoTimer = window.setTimeout(appendNext, 260);
}

function initializeReveal() {
  const items = document.querySelectorAll(".reveal");
  if (!("IntersectionObserver" in window)) {
    items.forEach((item) => item.classList.add("is-visible"));
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("is-visible");
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.14 });
  items.forEach((item) => observer.observe(item));
}

function initializeHeroMotion() {
  if (window.matchMedia("(prefers-reduced-motion: reduce), (pointer: coarse)").matches) return;
  const hero = document.querySelector(".hero");
  let frame;
  hero.addEventListener("pointermove", (event) => {
    window.cancelAnimationFrame(frame);
    frame = window.requestAnimationFrame(() => {
      const bounds = hero.getBoundingClientRect();
      const x = ((event.clientX - bounds.left) / bounds.width - 0.5) * 14;
      const y = ((event.clientY - bounds.top) / bounds.height - 0.5) * 10;
      hero.style.setProperty("--hero-x", `${x}px`);
      hero.style.setProperty("--hero-y", `${y}px`);
    });
  });
  hero.addEventListener("pointerleave", () => {
    hero.style.setProperty("--hero-x", "0px");
    hero.style.setProperty("--hero-y", "0px");
  });
}

function initializeNavigation() {
  const header = document.querySelector("[data-header]");
  const nav = document.querySelector("[data-nav]");
  const toggle = document.querySelector("[data-nav-toggle]");

  const updateHeader = () => header.classList.toggle("is-scrolled", window.scrollY > 24);
  updateHeader();
  window.addEventListener("scroll", updateHeader, { passive: true });

  toggle.addEventListener("click", () => {
    const open = nav.classList.toggle("is-open");
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "关闭菜单" : "打开菜单");
    toggle.innerHTML = `<i data-lucide="${open ? "x" : "menu"}" aria-hidden="true"></i>`;
    window.lucide?.createIcons();
  });

  nav.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      nav.classList.remove("is-open");
      toggle.setAttribute("aria-expanded", "false");
      toggle.innerHTML = '<i data-lucide="menu" aria-hidden="true"></i>';
      window.lucide?.createIcons();
    });
  });
}

document.querySelectorAll("[data-lang]").forEach((button) => {
  button.addEventListener("click", () => {
    applyLanguage(button.dataset.lang);
    if (!state.demoRunning) resetDemo();
  });
});

document.querySelectorAll("[data-platform]").forEach((button) => {
  button.addEventListener("click", () => applyPlatform(button.dataset.platform));
});

document.querySelectorAll("[data-copy], [data-copy-target]").forEach((button) => {
  button.addEventListener("click", () => copyText(button));
});

document.querySelector("[data-run-demo]").addEventListener("click", runDemo);

applyLanguage(state.language);
applyPlatform(state.platform);
initializeNavigation();
initializeReveal();
initializeHeroMotion();
window.lucide?.createIcons();

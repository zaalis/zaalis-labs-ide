const fs = require('fs');
const path = require('path');

const inputFile = path.join(__dirname, 'interface', 'script.js');
const outDir = path.join(__dirname, 'interface', 'script');
if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
}

const lines = fs.readFileSync(inputFile, 'utf-8').split(/\r?\n/);

const files = {
    state: [],
    ui: [],
    ai: [],
    main: []
};

// We will map sections to files
const sectionMap = {
    'STATE': 'state',
    'HELPERS': 'state',
    
    'DOM REFS (must be before INIT)': 'ui',
    'PROJECT MANAGEMENT': 'ui',
    'FILE TREE': 'ui',
    'FILE EDITOR': 'ui',
    'FILE TABS & EDITOR': 'ui',
    'PROFILE': 'ui',
    'AUTHENTICATION (mandatory login at startup)': 'ui',
    'UI: collapse sidebar / resize panels / collapse agent models / bounce': 'ui',
    
    'SETTINGS MODAL': 'main',
    'INIT': 'main',
    
    'PERMISSION MODE': 'ai',
    'AI PANEL TABS': 'ai',
    'AGENT MODE TOGGLE': 'ai',
    'CLEAR TERMINAL': 'ai',
    'MESSAGE HELPERS': 'ai',
    'CHAT - SINGLE AI': 'ai',
    'AGENTS MODE - MULTI AI': 'ai',
    'CONVERSATION HISTORY': 'ai',
    'ATTACHMENTS (images / files) - chat + agents': 'ai'
};

let currentFile = null;

for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Skip the opening wrapper
    if (i === 0 && line.includes('document.addEventListener')) continue;
    // Skip the closing wrapper
    if (i >= lines.length - 3 && line.includes('});')) continue;

    const sectionMatch = line.match(/^\s*\/\/\s+(.+)$/);
    if (sectionMatch && lines[i-1] && lines[i-1].includes('====') && lines[i+1] && lines[i+1].includes('====')) {
        let sectionName = sectionMatch[1].trim();
        
        if (sectionMap[sectionName]) {
            currentFile = sectionMap[sectionName];
        } else {
            console.warn("Unmapped section:", sectionName);
        }
    }

    if (currentFile) {
        // Fix indentation: remove exactly 4 spaces (1 level) of indentation
        let outLine = line;
        if (outLine.startsWith('    ')) {
            outLine = outLine.substring(4);
        }
        files[currentFile].push(outLine);
    }
}

// Write the files
for (const [key, content] of Object.entries(files)) {
    const filePath = path.join(outDir, `${key}.js`);
    fs.writeFileSync(filePath, content.join('\n'), 'utf-8');
    console.log(`Wrote ${content.length} lines to ${key}.js`);
}

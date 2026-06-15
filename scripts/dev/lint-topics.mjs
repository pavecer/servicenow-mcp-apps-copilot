#!/usr/bin/env node
/**
 * Topic Contract Linter for Copilot Studio AdaptiveDialog Format (Zero Dependencies)
 * 
 * Validates topics against card-rendering best practices:
 * 1. AdaptiveCardPrompt steps properly bind to variable outputs
 * 2. BeginDialog calls capture output variables
 * 3. Variable naming follows ServiceNow conventions
 * 4. Fallback handling present for critical paths
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOPIC_DIR = path.join(__dirname, 'topic_samples');
const ERRORS = [];
const WARNINGS = [];

/**
 * Validates a single topic file using regex patterns (no YAML lib needed)
 */
function lintTopic(filePath) {
  const fileName = path.basename(filePath);
  
  try {
    const content = fs.readFileSync(filePath, 'utf-8');

    if (!content.trim()) {
      ERRORS.push(`${fileName}: Empty file`);
      return;
    }

    // Rule 1: Check for AdaptiveDialog kind
    const isAdaptiveDialog = /^\s*kind:\s*AdaptiveDialog/m.test(content);
    if (!isAdaptiveDialog) {
      ERRORS.push(`${fileName}: Not a Copilot Studio AdaptiveDialog (missing 'kind: AdaptiveDialog')`);
      return;
    }

    // Rule 2: Check for beginDialog
    const hasBeginDialog = /^\s*beginDialog:/m.test(content);
    if (!hasBeginDialog) {
      ERRORS.push(`${fileName}: Missing 'beginDialog:' section`);
      return;
    }

    // Rule 3: Check for actions
    const hasActions = /^\s*actions:/m.test(content);
    if (!hasActions) {
      WARNINGS.push(`${fileName}: No actions found in beginDialog`);
    }

    // Rule 4: Check for Adaptive Card patterns
    checkAdaptiveCardPrompts(content, fileName);

    // Rule 5: Check BeginDialog output bindings
    checkBeginDialogOutputBindings(content, fileName);

    // Rule 6: Check variable naming conventions
    checkVariableNaming(content, fileName);

    // Rule 7: Check for error/fallback handling
    checkErrorHandling(content, fileName);

  } catch (err) {
    ERRORS.push(`${fileName}: Read error - ${err.message}`);
  }
}

/**
 * Validates AdaptiveCardPrompt patterns
 */
function checkAdaptiveCardPrompts(content, fileName) {
  const cardPromptMatches = [...content.matchAll(/kind:\s*AdaptiveCardPrompt/gm)];
  
  if (cardPromptMatches.length === 0) {
    return; // No card prompts in this topic
  }

  // For each AdaptiveCardPrompt, check that:
  // 1. It has an 'id' 
  // 2. It has a 'card:' property (not empty)
  // 3. If it sets output via 'output:', that variable is used later

  const cardPromptSections = content.split(/kind:\s*AdaptiveCardPrompt/);
  cardPromptSections.slice(1).forEach((section, idx) => {
    const hasId = /^\s*id:\s*\w+/m.test(section);
    if (!hasId) {
      WARNINGS.push(`${fileName}: AdaptiveCardPrompt #${idx + 1} missing 'id'`);
    }

    const hasCard = /^\s*card:/m.test(section);
    if (!hasCard) {
      ERRORS.push(`${fileName}: AdaptiveCardPrompt #${idx + 1} missing 'card:' property`);
    }

    // Check if card value looks empty or suspicious
    const cardValue = section.match(/^\s*card:\s*(.+)/m);
    if (cardValue && (cardValue[1].includes('=Blank()') || cardValue[1].trim() === '""')) {
      WARNINGS.push(`${fileName}: AdaptiveCardPrompt #${idx + 1} card value appears empty`);
    }

    // Check for output binding
    const hasOutput = /^\s*output:/m.test(section);
    if (!hasOutput) {
      WARNINGS.push(
        `${fileName}: AdaptiveCardPrompt #${idx + 1} has no output binding. ` +
        `Consider capturing user response with 'output: binding:' to use in follow-up actions.`
      );
    }
  });
}

/**
 * Validates BeginDialog output bindings
 */
function checkBeginDialogOutputBindings(content, fileName) {
  const beginDialogMatches = [...content.matchAll(/kind:\s*BeginDialog/gm)];
  
  if (beginDialogMatches.length === 0) {
    return;
  }

  const beginDialogSections = content.split(/kind:\s*BeginDialog/);
  beginDialogSections.slice(1).forEach((section, idx) => {
    // Check if dialog call has output binding (important for reusing results)
    const hasOutput = /^\s*output:/m.test(section);
    
    if (!hasOutput) {
      WARNINGS.push(
        `${fileName}: BeginDialog #${idx + 1} has no output binding. ` +
        `If the called dialog returns data (e.g., card), capture it with 'output: binding:' for use in follow-up rendering.`
      );
    }

    // Check if input binding is present
    const hasInput = /^\s*input:/m.test(section);
    if (!hasInput) {
      WARNINGS.push(`${fileName}: BeginDialog #${idx + 1} has no input binding (may be intentional)`);
    }
  });
}

/**
 * Check Copilot Studio variable naming conventions
 */
function checkVariableNaming(content, fileName) {
  const serviceNowPatterns = [
    'search_result', 'order_result', 'catalog_item', 'form_data',
    'item_details', 'ordering_result', 'error_message', 'response',
    'hrsd', 'metadata', 'user_input', 'case_data', 'cached', 'selected'
  ];
  
  const variableMatches = [...content.matchAll(/variable:\s*Topic\.(\w+)/gm)];
  
  variableMatches.forEach(match => {
    const varName = match[1];
    const isTooGeneric = /^(result|data|output|response|temp|tmp|x|y|z|var|item|list)$/i.test(varName);
    
    if (isTooGeneric) {
      WARNINGS.push(
        `${fileName}: Variable name 'Topic.${varName}' is too generic. ` +
        `Use descriptive names like search_result, catalog_item, hrsd_data, etc.`
      );
    }
  });
}

/**
 * Check for error handling and fallback patterns
 */
function checkErrorHandling(content, fileName) {
  // Look for try-catch or conditional handling
  const hasErrorHandling = /kind:\s*(ConditionGroup|ConditionBranch|SendActivity.*error|SendActivity.*fallback)/m.test(content);
  const hasBeginDialog = /kind:\s*BeginDialog/m.test(content);

  if (hasBeginDialog && !hasErrorHandling) {
    WARNINGS.push(
      `${fileName}: No error handling/fallback found after BeginDialog calls. ` +
      `Consider adding a ConditionBranch to handle failures gracefully.`
    );
  }
}

/**
 * Main
 */
function main() {
  console.log(`\n🔍 Linting Copilot Studio topics from: ${TOPIC_DIR}\n`);

  if (!fs.existsSync(TOPIC_DIR)) {
    console.error(`❌ Topic directory not found: ${TOPIC_DIR}`);
    process.exit(1);
  }

  const files = fs.readdirSync(TOPIC_DIR)
    .filter(f => (f.endsWith('.yaml') || f.endsWith('.yml')) && !f.startsWith('.'));

  if (files.length === 0) {
    console.log('ℹ️  No topic files found.\n');
    process.exit(0);
  }

  files.forEach(file => {
    lintTopic(path.join(TOPIC_DIR, file));
  });

  // Report
  console.log(`📋 Lint Results:`);
  console.log(`   Files scanned: ${files.length}`);
  console.log(`   Errors: ${ERRORS.length}`);
  console.log(`   Warnings: ${WARNINGS.length}\n`);

  if (ERRORS.length > 0) {
    console.log(`❌ ERRORS:\n`);
    ERRORS.forEach(e => console.log(`   • ${e}`));
    console.log();
  }

  if (WARNINGS.length > 0) {
    console.log(`⚠️  WARNINGS:\n`);
    WARNINGS.forEach(w => console.log(`   • ${w}`));
    console.log();
  }

  if (ERRORS.length === 0 && WARNINGS.length === 0) {
    console.log(`✅ All topics pass contract validation!\n`);
  }

  process.exit(ERRORS.length > 0 ? 1 : 0);
}

main();

'use strict';

/**
 * agente.js — Bucle agéntico con tool use de Anthropic.
 * runAgentLoop() acepta un executeTool inyectado para evitar dependencias circulares.
 */

const { anthropic } = require('./config');
const { TOOLS }     = require('./herramientas');

async function runAgentLoop(systemPrompt, userMessage, executeTool, maxIter = 12) {
  const messages = [{ role: 'user', content: userMessage }];
  let iter = 0;

  while (iter++ < maxIter) {
    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 4096,
      system:     systemPrompt,
      tools:      TOOLS,
      messages,
    });

    if (response.stop_reason === 'end_turn') {
      return response.content.find(c => c.type === 'text')?.text || '';
    }

    if (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content });
      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        console.log(`  🔧 Tool: ${block.name}(${JSON.stringify(block.input).slice(0, 100)})`);
        const result = await executeTool(block.name, block.input);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: String(result) });
      }
      messages.push({ role: 'user', content: toolResults });
    } else {
      break;
    }
  }
  return 'Análisis completado.';
}

module.exports = { runAgentLoop };

// @polsia:user-owned — catalogo di modelli esposti dal gateway LLM locale
// (http://192.168.0.117:8080, OpenAI-compatible). Lista piatta + grouping per
// provider per l'UI di /compare.

export const COMPARE_MODELS: readonly string[] = [
  'auto',
  // ARTEX (il pentest agent self-hosted; richiede ARTEX_URL + ARTEX_PASSWORD).
  // Il backend parla via conversation API + polling; la route emette SSE finti
  // (delta.content) così la card si popola col testo progressivo.
  'artex',
  // aihorde (sotto-provider Qwen/koboldcpp/aphrodite/lmstudio/meta-llama)
  'aihorde:Qwen/Qwen3.8-Flash-Next',
  'aihorde:aphrodite/SicariusSicariiStuff/Impish_Bloodmoon_12B',
  'aihorde:aphrodite/SicariusSicariiStuff/Impish_LLAMA_4B',
  'aihorde:aphrodite/TheDrummer/Behemoth-128B-v3',
  'aihorde:aphrodite/TheDrummer/Behemoth-X-123B-v2.1',
  'aihorde:aphrodite/TheDrummer/Cydonia-24B-v4.3',
  'aihorde:aphrodite/TheDrummer/Skyfall-31B-v4.2',
  'aihorde:koboldcpp/Angelic_Eclipse-12B',
  'aihorde:koboldcpp/Cydonia-24B-v4.3',
  'aihorde:koboldcpp/Cydonia-24B-v4zg-Q4_K_M',
  'aihorde:koboldcpp/G4-MeroMero-26B-A4B-it-uncensored-heretic',
  'aihorde:koboldcpp/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive',
  'aihorde:koboldcpp/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q4_K_M',
  'aihorde:koboldcpp/HauhauCS/Qwen3.5-9B-Uncensored-HauhauCS-Aggressive',
  'aihorde:koboldcpp/L3-8B-Stheno-v3.2',
  'aihorde:koboldcpp/L3-8B-Stheno-v3.2-Q5_K_M',
  'aihorde:koboldcpp/L3-Super-Nova-RP-8B',
  'aihorde:koboldcpp/LFM-3-Coder-Claude-Distill.Q8_0.gguf',
  'aihorde:koboldcpp/LFM3-1.7B-Q8_0.gguf',
  'aihorde:koboldcpp/Llama-3-Lumimaid-8B-v0.1',
  'aihorde:koboldcpp/Llama-3.2-1B-Instruct',
  'aihorde:koboldcpp/Llama-3.2-1B-Instruct-Uncensored',
  'aihorde:koboldcpp/Llama-3.2-3B',
  'aihorde:koboldcpp/Llama-3.2-3B-Instruct',
  'aihorde:koboldcpp/Llama-3.2-3B-Instruct-Q4_K_M',
  'aihorde:koboldcpp/MN-Violet-Lotus-12B.Q8_0',
  'aihorde:koboldcpp/Orion-26B-A4B-v1.1',
  'aihorde:koboldcpp/Phi-3.5-mini-instruct',
  'aihorde:koboldcpp/Qwen/Qwen3.5-0.8B',
  'aihorde:koboldcpp/Qwen/Qwen3.8-27B',
  'aihorde:koboldcpp/Qwen2.5-Coder-3B-Instruct',
  'aihorde:koboldcpp/Qwen3-0.6B',
  'aihorde:koboldcpp/Qwen3-1.7B',
  'aihorde:koboldcpp/Qwen3-14B',
  'aihorde:koboldcpp/Qwen3-4B-Nymphaea-RP.i1-Q4_K_S',
  'aihorde:koboldcpp/Qwen_Qwen3-0.6B-IQ4_XS',
  'aihorde:koboldcpp/ReadyArt/Forgotten-Safeword-22B',
  'aihorde:koboldcpp/Rocinante-X-12B-v1',
  'aihorde:koboldcpp/Rocinante-XL-16B-v1',
  'aihorde:koboldcpp/Sao10K/L3-8B-Stheno-v3.2',
  'aihorde:koboldcpp/Skyfall-31B-v4.2',
  'aihorde:koboldcpp/TheDrummer_Behemoth-128B-v3-Q4_K_M',
  'aihorde:koboldcpp/[ctx:65536] Magidonia-24B-heretic-',
  'aihorde:koboldcpp/debug-Vesper-26B-A4B-Nocturne.i1-Q4_K_M_hb16',
  'aihorde:koboldcpp/debug-gemma-4-E2B-Queen-it-qat-q4_0-unquantized.i1-Q4_K_M',
  'aihorde:koboldcpp/digo-prayudha/unsloth-llama-3.2-1b-gguf',
  'aihorde:koboldcpp/gemma-3-4b-it-Q4_K_M',
  'aihorde:koboldcpp/gemma-4-31B-it-heretic',
  'aihorde:koboldcpp/gemma-4-E4B-it',
  'aihorde:koboldcpp/llama-3.2-3b-instruct-q4_k_m',
  'aihorde:koboldcpp/lunahr/thea-rp-3b-25r',
  'aihorde:koboldcpp/mini-magnum-12b-v1.1',
  'aihorde:koboldcpp/mradermacher/Cerebras-GPT-111M-instruction-GGUF',
  'aihorde:koboldcpp/mradermacher/Qwen3.5-9B-Claude-4.6-HighIQ-THINKING-HERETIC-UNCENSORED-i1',
  'aihorde:koboldcpp/mradermacher/pythia-70m-deduped.f16.gguf',
  'aihorde:lmstudio/Qwen3.5-9B-Uncensored-HauhauCS-Aggressive',
  'aihorde:lmstudio/Qwen3.6-35B-A3B',
  'aihorde:lmstudio/Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive',
  'aihorde:meta-llama/Llama-3.2-3B-Instruct',
  // kilo
  'kilo:baidu/ernie-5.5-flash-preview:free',
  'kilo:inclusionai/ling-3.2-flash:free',
  'kilo:kilo-auto/free',
  'kilo:liquid/lfm-3-1.7b:free',
  'kilo:nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'kilo:nvidia/nemotron-3-ultra-550b-a55b:free',
  'kilo:nvidia/nemotron-3.5-lightning:free',
  'kilo:nvidia/nemotron-3.5-super-vl:free',
  'kilo:openrouter/free',
  'kilo:particle-ai/particle-1:free',
  'kilo:reflection/beam-free',
  'kilo:stealth/glyph-cluster',
  // ovh
  'ovh:DeepSeek-V4.1-Flash-1017',
  'ovh:Meta-Llama-3_3-70B-Instruct',
  'ovh:Mistral-Small-3.2-24B-Instruct-2506',
  'ovh:Olala-v1.0-mini-7A1B',
  'ovh:Qwen2.5-VL-72B-Instruct',
  'ovh:Qwen3.5-397B-A17B',
  'ovh:Qwen3.5-9B',
  'ovh:Qwen3.6-27B',
  'ovh:Qwen3.8-27B',
  'ovh:Qwen3Guard-Gen-0.6B',
  'ovh:Qwen3Guard-Gen-8B',
  'ovh:gemma-4-26b-a4b',
  'ovh:gpt-oss-120b',
  'ovh:gpt-oss-20b',
  'ovh:laguna-xs-2.1',
  'ovh:nemotron3-nano-30b',
  'ovh:nemotron3-omni-30b',
  'ovh:qwen3-vl-30b-a3b',
  'ovh:qwen3.6-35b-a3b',
];

export type CompareProvider = 'auto' | 'artex' | 'aihorde' | 'kilo' | 'ovh';

export function providerOf(modelId: string): CompareProvider {
  if (modelId === 'auto') return 'auto';
  if (modelId === 'artex' || modelId.startsWith('artex:')) return 'artex';
  const prefix = modelId.split(':', 1)[0];
  if (prefix === 'aihorde' || prefix === 'kilo' || prefix === 'ovh') return prefix;
  return 'auto';
}

export function groupedModels(): Record<CompareProvider, string[]> {
  const out: Record<CompareProvider, string[]> = {
    auto: [],
    artex: [],
    aihorde: [],
    kilo: [],
    ovh: [],
  };
  for (const id of COMPARE_MODELS) out[providerOf(id)].push(id);
  return out;
}

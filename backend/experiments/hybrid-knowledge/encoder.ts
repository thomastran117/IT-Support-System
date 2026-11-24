import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env, pipeline } from '@huggingface/transformers';
import { modelId, type Embed } from './hybrid.js';

const fileHashes = {
  'config.json': '7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7',
  'tokenizer.json': 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0',
  'tokenizer_config.json': '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3',
  'onnx/model_quantized.onnx': 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1',
};

export async function openLocalEncoder(modelDirectory: string) {
  for (const [file, expected] of Object.entries(fileHashes)) {
    const bytes = await readFile(join(modelDirectory, modelId, file));
    if (createHash('sha256').update(bytes).digest('hex') !== expected) {
      throw new Error(`Local model checksum mismatch for ${file}`);
    }
  }

  env.allowRemoteModels = false;
  env.localModelPath = modelDirectory;
  env.useFSCache = false;
  const model = await pipeline('feature-extraction', modelId, {
    local_files_only: true,
    device: 'cpu',
    dtype: 'q8',
    session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
  });
  const embed: Embed = async (texts) =>
    (await model(texts, { pooling: 'mean', normalize: true })).tolist() as number[][];
  return { embed, close: () => model.dispose() };
}

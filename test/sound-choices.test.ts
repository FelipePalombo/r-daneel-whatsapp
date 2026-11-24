import test from 'node:test';
import assert from 'node:assert/strict';
import { SoundChoices } from '../src/sound-choices.js';

test('isola conversas, exige citação em respostas ambíguas e limita pendências', () => {
  const choices = new SoundChoices(3, 1000), received: string[] = [];
  assert.equal(choices.add('a', '1', (sound) => received.push(`1:${sound}`)), true);
  assert.equal(choices.add('a', '2', (sound) => received.push(`2:${sound}`)), true);
  assert.equal(choices.add('b', '3', (sound) => received.push(`3:${sound}`)), true);
  assert.equal(choices.add('b', '4', () => {}), false);
  assert.equal(choices.respond('a', '!som'), 'ambiguous');
  assert.equal(choices.respond('b', '!som', '1'), 'unmatched');
  assert.equal(choices.respond('a', ' !SOM ', '2'), 'accepted');
  assert.equal(choices.respond('a', 'não'), 'accepted');
  assert.equal(choices.respond('b', '!som'), 'accepted');
  assert.deepEqual(received, ['2:true', '1:false', '3:true']);
  assert.equal(choices.size, 0);
  choices.close();
});

test('expiração responde sem som e fecha uma única vez', async () => {
  const choices = new SoundChoices(1, 10), results: boolean[][] = [];
  choices.add('a', '1', (sound, expired) => results.push([sound, expired]));
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(results, [[false, true]]);
  assert.equal(choices.respond('a', '!som'), 'unmatched');
  choices.close();
});

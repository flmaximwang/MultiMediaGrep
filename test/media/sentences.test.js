// test/media/sentences.test.js —— 句子切分（预览抽样的“完整单元”）
//
// 重点不是「切得多准」，而是**不在假句末上切断**：
// 缩写（et al. / e.g. / i.e. / Fig.）、引用编号（Fig. 3 / Eq. 2）、小数（1.5 mM）。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { splitSentences } from '../../src/media/sentences.js';

test('splitSentences：空输入返回空数组', () => {
  assert.deepEqual(splitSentences(''), []);
  assert.deepEqual(splitSentences(null), []);
  assert.deepEqual(splitSentences('   \n\t  '), []);
});

test('splitSentences：正常英文句子按句末标点切', () => {
  assert.deepEqual(
    splitSentences('First sentence. Second sentence! Third one? Fourth; fifth.'),
    ['First sentence.', 'Second sentence!', 'Third one?', 'Fourth;', 'fifth.'],
  );
});

test('splitSentences：不在 "et al." 后断句', () => {
  assert.deepEqual(
    splitSentences('Zhang et al. reported the effect. It replicated.'),
    ['Zhang et al. reported the effect.', 'It replicated.'],
  );
  assert.deepEqual(
    splitSentences('As shown by Lee et al. The result held.'),
    ['As shown by Lee et al. The result held.'],
  );
});

test('splitSentences：不在 "Fig. 3" / "Eq. 2" 这类编号引用处断句', () => {
  assert.deepEqual(
    splitSentences('See Fig. 3 for the curve. The next figure differs.'),
    ['See Fig. 3 for the curve.', 'The next figure differs.'],
  );
  assert.deepEqual(
    splitSentences('Equation (2) follows Eq. 4 exactly.'),
    ['Equation (2) follows Eq. 4 exactly.'],
  );
});

test('splitSentences：不在缩写 e.g. / i.e. / etc. 处断句', () => {
  assert.deepEqual(
    splitSentences('Use a buffer, e.g. PBS, at pH 7.4. Then wash.'),
    ['Use a buffer, e.g. PBS, at pH 7.4.', 'Then wash.'],
  );
  assert.deepEqual(
    splitSentences('It is acidic, i.e. the pH is low. Handle carefully.'),
    ['It is acidic, i.e. the pH is low.', 'Handle carefully.'],
  );
  assert.deepEqual(
    splitSentences('Add salts, etc. Mix well.'),
    ['Add salts, etc. Mix well.'],
  );
});

test('splitSentences：不在小数 / 版本号处断句', () => {
  assert.deepEqual(
    splitSentences('Use 1.5 mM of the reagent. Incubate at 37.5 C.'),
    ['Use 1.5 mM of the reagent.', 'Incubate at 37.5 C.'],
  );
  assert.deepEqual(splitSentences('Upgrade to v1.2.3 before the run.'), ['Upgrade to v1.2.3 before the run.']);
});

test('splitSentences：中文按 。！？； 切，且换行不插空格', () => {
  assert.deepEqual(
    splitSentences('第一句话。第二句话！第三句话？第四句话；第五句话'),
    ['第一句话。', '第二句话！', '第三句话？', '第四句话；', '第五句话'],
  );
  assert.deepEqual(
    splitSentences('这是第一行\n这是第二行。\n\n下 一 段。'),
    ['这是第一行这是第二行。', '下 一 段。'],
  );
});

test('splitSentences：收尾引号 / 括号归前一句', () => {
  assert.deepEqual(
    splitSentences('He said "stop." Then he left.'),
    ['He said "stop."', 'Then he left.'],
  );
  assert.deepEqual(
    splitSentences('这是「第一句。」然后呢？'),
    ['这是「第一句。」', '然后呢？'],
  );
});

test('splitSentences：没有标点的长文本是一个单元（交给上层硬截断）', () => {
  const blob = '无标点的超长文本'.repeat(50);
  assert.deepEqual(splitSentences(blob), [blob]);
  assert.deepEqual(splitSentences('one long run with no terminator'), ['one long run with no terminator']);
});

test('splitSentences：空白被折叠，不会产生空句子', () => {
  assert.deepEqual(
    splitSentences('  A.  B.  C.  '),
    ['A.', 'B.', 'C.'],
  );
});

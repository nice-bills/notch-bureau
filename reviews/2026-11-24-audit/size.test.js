import test from 'node:test';
import * as L from '/home/bills/code/dev3pack/notch/tests/lib.js';
test('line size', async () => { const ctx = await L.setup(); await L.open(ctx); console.log('CreditLine data length', ctx.svm.getAccount(ctx.line).data.length); });

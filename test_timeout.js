const { spawn } = require('child_process');
const fs = require('fs');
fs.writeFileSync('test.cpp', 'int main() { while(true) {} return 0; }');
require('child_process').execSync('g++ test.cpp -o test');
console.log('Running...');
const start = Date.now();
const run = spawn('./test', [], { timeout: 5000 });
run.on('close', (code, signal) => {
  console.log(`Closed after ${Date.now() - start}ms with code ${code} and signal ${signal}`);
});

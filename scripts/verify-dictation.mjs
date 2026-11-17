import { openDb, get } from '../src/db.js';
import { config } from '../src/config.js';
import { draftNoteFromDictation } from '../src/ai/orchestrator.js';

openDb(config.dbPath);
const user = get('SELECT * FROM users WHERE email=?', 'resident@rounds.test');
const patient = get("SELECT * FROM patients WHERE display_name LIKE '%Rosa%'");
const out = await draftNoteFromDictation({
  user,
  patient,
  input: {
    note_type: 'progress',
    transcript:
      'Patient feels better overnight. Soft abdomen nontender. Plan continue ceftriaxone and recheck creatinine this evening.',
  },
});
console.log('status', out.status);
for (const s of out.content?.sections || []) {
  console.log('-', s.key, ':', String(s.text).slice(0, 120));
}

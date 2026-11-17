import { openDb, get, all } from '../src/db.js';
import { config } from '../src/config.js';

openDb(config.dbPath);
const rosa = get("SELECT id, display_name, room FROM patients WHERE display_name LIKE '%Rosa%'");
console.log('Rosa', rosa);
if (!rosa) process.exit(1);
const problems = all('SELECT label, code_suggestion FROM problems WHERE patient_id=?', rosa.id);
console.log('Problems', problems.map((p) => ({ label: p.label, code: p.code_suggestion })));
const plan = get('SELECT text FROM plans WHERE patient_id=? ORDER BY created_at DESC LIMIT 1', rosa.id);
console.log('Plan:\n', plan?.text);
const mcqs = all("SELECT topic, status FROM mcqs WHERE topic LIKE '%Elevated%' OR topic LIKE '%kidney%'");
console.log('MCQs', mcqs);
const idFacts = all("SELECT label, value, reviewer_status FROM facts WHERE label LIKE '%Name%' OR value LIKE '%Doe%' OR label LIKE '%Visit%'");
console.log('Identity facts', idFacts);
const trendsNote = all("SELECT label, value, unit, source_passage FROM facts WHERE patient_id=? AND label LIKE '%Creatinine%'", rosa.id);
console.log('Creatinine facts', trendsNote);

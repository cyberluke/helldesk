import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../services/helldesk/local-live/ui');
const names=new Set();
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
 const file=path.join(dir,entry.name); if(entry.isDirectory()) walk(file);
 else if(/\.[jt]sx?$/.test(entry.name)){
  const source=fs.readFileSync(file,'utf8');
  for(const match of source.matchAll(/import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]lucide-react['"]/g))
   for(const item of match[1].split(',')){const name=item.trim().split(/\s+as\s+/)[0].replace(/^type\s+/,'');if(name)names.add(name);}
  if(process.argv.includes('--apply')) fs.writeFileSync(file,source.replace(/from (['"])lucide-react\1/g,"from '@/lib/icons'"));
 }
}}
walk(path.join(root,'src'));walk(path.join(root,'federated'));
console.log([...names].sort().join(', '));

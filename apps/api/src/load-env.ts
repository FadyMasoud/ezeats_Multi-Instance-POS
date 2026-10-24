import { resolve } from 'node:path';
import { config } from 'dotenv';

// Local runs read the repo-root .env (src/ and dist/ are both three levels below it).
// In containers the file does not exist and real environment variables are used.
config({ path: resolve(__dirname, '..', '..', '..', '.env') });

import argon2 from 'argon2';

// Fixed dummy hash used to keep timing constant when the login is unknown
// (contract §7 brute force/enumeration: "constant-time проверка dummy hash
// для неизвестного login"). Generated once; not a real credential.
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHRzb21lc2FsdA$3sSJ5o8W8k3z2sYFQ1n0hATuMlHnQGZ3sZ6zL9x8m1w';

export async function verifyPassword(hash: string | null, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash ?? DUMMY_HASH, password);
  } catch {
    return false;
  }
}

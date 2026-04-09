import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** True if `filePath` is the same path or nested under `rootDir` (after resolve). */
export function isPathUnderRoot(filePath: string, rootDir: string): boolean {
  const f = path.resolve(filePath)
  const r = path.resolve(rootDir)
  return f === r || f.startsWith(r + path.sep)
}

export function assertPathUnderRoot(filePath: string, rootDir: string): void {
  if (!isPathUnderRoot(filePath, rootDir)) {
    throw new Error('Refusing to write outside allowed config directory')
  }
}

/**
 * Write root-owned files via sudo (local dev only; password on stdin).
 * Content is written to a private temp file, then `sudo cp` installs it. That way stdin only
 * carries the password — some sudo versions forward the whole stream to `tee`/`cat` children,
 * which previously put the password into the config.
 */
export async function writeFileAsRootViaSudo(
  absolutePath: string,
  utf8Content: string,
  password: string,
): Promise<void> {
  if (process.platform === 'win32') {
    return Promise.reject(
      new Error('Elevated file write from the API is not supported on Windows. Run the dev server as Administrator or edit the file manually.'),
    )
  }
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-manager-sudo-'))
  const tmpFile = path.join(tmpDir, 'payload')
  try {
    await fs.writeFile(tmpFile, utf8Content, 'utf8')
    await fs.chmod(tmpFile, 0o600)
    await new Promise<void>((resolve, reject) => {
      const child = spawn('sudo', ['-S', '/bin/cp', '-f', tmpFile, absolutePath], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stderr = ''
      child.stderr.on('data', (c) => {
        stderr += c.toString()
      })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(stderr.trim() || `sudo cp exited with code ${code}`))
      })
      child.stdin.write(password + '\n', 'utf8', (err) => {
        if (err) reject(err)
        else child.stdin.end()
      })
    })
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

export function mkdirPAsRootViaSudo(absoluteDir: string, password: string): Promise<void> {
  if (process.platform === 'win32') {
    return Promise.reject(new Error('Elevated mkdir is not supported on Windows from the API.'))
  }
  return new Promise((resolve, reject) => {
    const child = spawn('sudo', ['-S', 'mkdir', '-p', absoluteDir], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (c) => {
      stderr += c.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `sudo mkdir exited with code ${code}`))
    })
    child.stdin.write(password + '\n', 'utf8', (err) => {
      if (err) reject(err)
      else child.stdin.end()
    })
  })
}

/**
 * Run `sudo -S command ...args` with password on stdin (no shell).
 * Used for `nginx -t`, etc., when the unprivileged run hits root-only paths like `/run/nginx.pid`.
 */
export function execWithSudo(
  password: string,
  command: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  if (process.platform === 'win32') {
    return Promise.reject(new Error('sudo is not used on Windows from this API.'))
  }
  return new Promise((resolve, reject) => {
    const child = spawn('sudo', ['-S', command, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout?.on('data', (c: string) => {
      stdout += c
    })
    child.stderr.on('data', (c: string) => {
      stderr += c
    })
    child.on('error', reject)
    child.on('close', (exitCode) => {
      resolve({ stdout, stderr, exitCode })
    })
    child.stdin.write(password + '\n', 'utf8', (err) => {
      if (err) reject(err)
      else child.stdin.end()
    })
  })
}

export type ElevatedWriteResult =
  | { ok: true }
  | {
      ok: false
      httpStatus: number
      error: string
      code: string
      needsElevation?: boolean
    }

export type ElevatedReadResult =
  | { ok: true; content: string }
  | {
      ok: false
      httpStatus: number
      error: string
      code: string
      needsElevation?: boolean
    }

/** Read a root-owned file: `sudo cat path` (password on stdin only; file path is an argument). */
export function readFileAsRootViaSudo(absolutePath: string, password: string): Promise<string> {
  if (process.platform === 'win32') {
    return Promise.reject(new Error('Elevated read is not supported on Windows from the API.'))
  }
  return new Promise((resolve, reject) => {
    const child = spawn('sudo', ['-S', '/bin/cat', '--', absolutePath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const chunks: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => {
      chunks.push(c)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c: string) => {
      stderr += c
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks).toString('utf8'))
      } else {
        reject(new Error(stderr.trim() || `sudo cat exited with code ${code}`))
      }
    })
    child.stdin.write(password + '\n', 'utf8', (err) => {
      if (err) reject(err)
      else child.stdin.end()
    })
  })
}

export async function readFileMaybeElevated(
  filePath: string,
  rootDir: string,
  sudoPassword?: string,
): Promise<ElevatedReadResult> {
  assertPathUnderRoot(filePath, rootDir)
  try {
    const content = await fs.readFile(filePath, 'utf8')
    return { ok: true, content }
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'ENOENT') {
      return { ok: false, httpStatus: 404, error: 'File not found', code: 'ENOENT' }
    }
    const denied = err.code === 'EACCES' || err.code === 'EPERM'
    if (denied && sudoPassword && process.platform !== 'win32') {
      try {
        const content = await readFileAsRootViaSudo(filePath, sudoPassword)
        return { ok: true, content }
      } catch (e2) {
        return {
          ok: false,
          httpStatus: 403,
          error: (e2 as Error).message,
          code: 'ELEVATION_FAILED',
        }
      }
    }
    if (denied) {
      return {
        ok: false,
        httpStatus: 403,
        error: err.message,
        code: err.code || 'EACCES',
        needsElevation: process.platform !== 'win32',
      }
    }
    return {
      ok: false,
      httpStatus: 500,
      error: err.message,
      code: err.code || 'EIO',
    }
  }
}

export async function writeFileMaybeElevated(
  filePath: string,
  content: string,
  rootDir: string,
  sudoPassword?: string,
): Promise<ElevatedWriteResult> {
  assertPathUnderRoot(filePath, rootDir)
  try {
    await fs.writeFile(filePath, content, 'utf8')
    return { ok: true }
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    const denied = err.code === 'EACCES' || err.code === 'EPERM'
    if (denied && sudoPassword && process.platform !== 'win32') {
      try {
        await writeFileAsRootViaSudo(filePath, content, sudoPassword)
        return { ok: true }
      } catch (e2) {
        return {
          ok: false,
          httpStatus: 403,
          error: (e2 as Error).message,
          code: 'ELEVATION_FAILED',
        }
      }
    }
    if (denied) {
      return {
        ok: false,
        httpStatus: 403,
        error: err.message,
        code: err.code || 'EACCES',
        needsElevation: process.platform !== 'win32',
      }
    }
    return {
      ok: false,
      httpStatus: 500,
      error: err.message,
      code: err.code || 'EIO',
    }
  }
}

export async function mkdirMaybeElevated(
  dir: string,
  rootDir: string,
  sudoPassword?: string,
): Promise<ElevatedWriteResult> {
  assertPathUnderRoot(dir, rootDir)
  try {
    await fs.mkdir(dir, { recursive: true })
    return { ok: true }
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    const denied = err.code === 'EACCES' || err.code === 'EPERM'
    if (denied && sudoPassword && process.platform !== 'win32') {
      try {
        await mkdirPAsRootViaSudo(dir, sudoPassword)
        return { ok: true }
      } catch (e2) {
        return {
          ok: false,
          httpStatus: 403,
          error: (e2 as Error).message,
          code: 'ELEVATION_FAILED',
        }
      }
    }
    if (denied) {
      return {
        ok: false,
        httpStatus: 403,
        error: err.message,
        code: err.code || 'EACCES',
        needsElevation: process.platform !== 'win32',
      }
    }
    return {
      ok: false,
      httpStatus: 500,
      error: err.message,
      code: err.code || 'EIO',
    }
  }
}

export function unlinkAsRootViaSudo(absolutePath: string, password: string): Promise<void> {
  if (process.platform === 'win32') {
    return Promise.reject(new Error('Elevated delete is not supported on Windows from this API.'))
  }
  return new Promise((resolve, reject) => {
    const child = spawn('sudo', ['-S', 'rm', '-f', absolutePath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (c) => {
      stderr += c.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `sudo rm exited with code ${code}`))
    })
    child.stdin.write(password + '\n', 'utf8', (err) => {
      if (err) reject(err)
      else child.stdin.end()
    })
  })
}

export function symlinkAsRootViaSudo(
  absoluteTarget: string,
  absoluteLinkPath: string,
  password: string,
): Promise<void> {
  if (process.platform === 'win32') {
    return Promise.reject(
      new Error('Elevated symlink is not supported on Windows from the API.'),
    )
  }
  return new Promise((resolve, reject) => {
    const child = spawn('sudo', ['-S', 'ln', '-sf', absoluteTarget, absoluteLinkPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (c) => {
      stderr += c.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `sudo ln exited with code ${code}`))
    })
    child.stdin.write(password + '\n', 'utf8', (err) => {
      if (err) reject(err)
      else child.stdin.end()
    })
  })
}

/**
 * Debian-style layout: symlink `sites-enabled/<base>` → `sites-available/<base>`
 * so nginx/apache pick up the vhost without a separate enable step.
 */
export async function enableDebianStyleVhostSite(
  rootDir: string,
  baseName: string,
  sudoPassword?: string,
): Promise<ElevatedWriteResult> {
  const saFile = path.join(rootDir, 'sites-available', baseName)
  const enLink = path.join(rootDir, 'sites-enabled', baseName)
  assertPathUnderRoot(saFile, rootDir)
  assertPathUnderRoot(enLink, rootDir)

  try {
    await fs.access(saFile)
  } catch {
    return {
      ok: false,
      httpStatus: 500,
      error: 'sites-available file is missing',
      code: 'ENOENT',
    }
  }

  const md = await mkdirMaybeElevated(
    path.join(rootDir, 'sites-enabled'),
    rootDir,
    sudoPassword,
  )
  if (md.ok === false) return md

  const targetRelative = path.join('..', 'sites-available', baseName)
  const wantResolved = path.resolve(saFile)

  try {
    await fs.symlink(targetRelative, enLink)
    return { ok: true }
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'EEXIST') {
      try {
        const st = await fs.lstat(enLink)
        if (st.isSymbolicLink()) {
          const cur = await fs.readlink(enLink)
          const resolved = path.resolve(path.dirname(enLink), cur)
          if (resolved === wantResolved) return { ok: true }
        }
      } catch {
        /* fall through */
      }
      return {
        ok: false,
        httpStatus: 409,
        error: 'sites-enabled already has an entry with this name',
        code: 'EEXIST',
      }
    }
    const denied = err.code === 'EACCES' || err.code === 'EPERM'
    if (denied && sudoPassword && process.platform !== 'win32') {
      try {
        await symlinkAsRootViaSudo(wantResolved, path.resolve(enLink), sudoPassword)
        return { ok: true }
      } catch (e2) {
        return {
          ok: false,
          httpStatus: 403,
          error: (e2 as Error).message,
          code: 'ELEVATION_FAILED',
        }
      }
    }
    if (denied) {
      return {
        ok: false,
        httpStatus: 403,
        error: err.message,
        code: err.code || 'EACCES',
        needsElevation: process.platform !== 'win32',
      }
    }
    return {
      ok: false,
      httpStatus: 500,
      error: err.message,
      code: err.code || 'EIO',
    }
  }
}

export async function unlinkMaybeElevated(
  filePath: string,
  rootDir: string,
  sudoPassword?: string,
): Promise<ElevatedWriteResult> {
  assertPathUnderRoot(filePath, rootDir)
  try {
    await fs.unlink(filePath)
    return { ok: true }
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'ENOENT') {
      return {
        ok: false,
        httpStatus: 404,
        error: 'File not found',
        code: 'ENOENT',
      }
    }
    const denied = err.code === 'EACCES' || err.code === 'EPERM'
    if (denied && sudoPassword && process.platform !== 'win32') {
      try {
        await unlinkAsRootViaSudo(filePath, sudoPassword)
        return { ok: true }
      } catch (e2) {
        return {
          ok: false,
          httpStatus: 403,
          error: (e2 as Error).message,
          code: 'ELEVATION_FAILED',
        }
      }
    }
    if (denied) {
      return {
        ok: false,
        httpStatus: 403,
        error: err.message,
        code: err.code || 'EACCES',
        needsElevation: process.platform !== 'win32',
      }
    }
    return {
      ok: false,
      httpStatus: 500,
      error: err.message,
      code: err.code || 'EIO',
    }
  }
}

/** Remove `sites-enabled` link when deleting a file under `sites-available` (Debian layout). */
export async function removeVhostConfigFile(
  rootDir: string,
  filePath: string,
  sudoPassword?: string,
): Promise<ElevatedWriteResult> {
  assertPathUnderRoot(filePath, rootDir)
  const sa = path.resolve(path.join(rootDir, 'sites-available'))
  const rp = path.resolve(filePath)
  if (rp === sa || rp.startsWith(sa + path.sep)) {
    const base = path.basename(rp)
    const enPath = path.join(rootDir, 'sites-enabled', base)
    try {
      await fs.lstat(enPath)
      const r = await unlinkMaybeElevated(enPath, rootDir, sudoPassword)
      if (r.ok === false) return r
    } catch {
      /* no symlink */
    }
  }
  return unlinkMaybeElevated(filePath, rootDir, sudoPassword)
}

/** Hosts file only — `targetPath` must match `allowedPath` after resolve. */
export async function writeHostsMaybeElevated(
  allowedPath: string,
  targetPath: string,
  content: string,
  sudoPassword?: string,
): Promise<ElevatedWriteResult> {
  if (path.resolve(targetPath) !== path.resolve(allowedPath)) {
    return {
      ok: false,
      httpStatus: 400,
      error: 'Invalid hosts path',
      code: 'EINVAL',
    }
  }
  try {
    await fs.writeFile(targetPath, content, 'utf8')
    return { ok: true }
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    const denied = err.code === 'EACCES' || err.code === 'EPERM'
    if (denied && sudoPassword && process.platform !== 'win32') {
      try {
        await writeFileAsRootViaSudo(targetPath, content, sudoPassword)
        return { ok: true }
      } catch (e2) {
        return {
          ok: false,
          httpStatus: 403,
          error: (e2 as Error).message,
          code: 'ELEVATION_FAILED',
        }
      }
    }
    if (denied) {
      return {
        ok: false,
        httpStatus: 403,
        error: err.message,
        code: err.code || 'EACCES',
        needsElevation: process.platform !== 'win32',
      }
    }
    return {
      ok: false,
      httpStatus: 500,
      error: err.message,
      code: err.code || 'EIO',
    }
  }
}

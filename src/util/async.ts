/** Promise helpers with one definition each. */

/** The promise's value, or undefined when it has not settled within `ms`. The timer is always cleared, so a settled
 *  promise never leaves a pending timeout holding the process open. A rejection of `promise` still rejects. */
export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([promise, new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms); })]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

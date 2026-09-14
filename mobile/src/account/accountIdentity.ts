export function shouldClearPrivateLocalData(
  previousUserId: string | null | undefined,
  currentUserId: string | null,
): boolean {
  return previousUserId !== undefined && previousUserId !== currentUserId;
}

export class InstanceNotFoundError extends Error {
  constructor(id: string) {
    super(`Instance ${id} not found`);
    this.name = "InstanceNotFoundError";
  }
}
export class InstanceNotInitializedError extends Error {
  constructor(id: string) {
    super(`Instance ${id} not found or not initialized`);
    this.name = "InstanceNotInitializedError";
  }
}

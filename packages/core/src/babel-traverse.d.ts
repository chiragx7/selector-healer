// Ambient override for @babel/traverse under NodeNext module resolution.
// @types/babel__traverse declares `export default traverse` but NodeNext
// treats the CJS package's default import as the full namespace object,
// making the callable signatures invisible. This declaration restores them.
declare module '@babel/traverse' {
  import type { Node } from '@babel/types';

  export interface TraverseOptions<S = Node> {
    enter?: ((path: NodePath<Node>, state: S) => void) | undefined;
    exit?: ((path: NodePath<Node>, state: S) => void) | undefined;
    [key: string]: unknown;
  }

  export class Scope {
    path: NodePath;
    block: Node;
    parentBlock: Node;
    parent: Scope | undefined;
    bindings: Record<string, Binding>;
  }

  export class Binding {
    identifier: Node;
    scope: Scope;
    path: NodePath;
    kind: 'var' | 'let' | 'const' | 'module' | 'hoisted' | 'param' | 'local' | 'unknown';
  }

  export class NodePath<T extends Node = Node> {
    node: T;
    parent: Node;
    parentPath: NodePath | null;
    scope: Scope;
    type: T['type'];
  }

  function traverse<S>(
    parent: Node,
    opts: TraverseOptions<S>,
    scope?: Scope,
    state?: S,
    parentPath?: NodePath,
  ): void;
  function traverse(parent: Node, opts?: TraverseOptions): void;

  export default traverse;
}

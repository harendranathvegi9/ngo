import * as fs from 'fs';
import * as ts from 'typescript';

const script = process.argv[2];
let contents = fs.readFileSync(script).toString();

const options: ts.CompilerOptions = {
  allowJs: true,
};
const program = ts.createProgram([script], options);
const source = program.getSourceFile(script);
//const source = ts.createSourceFile(script, contents, ts.ScriptTarget.ES5, false, ts.ScriptKind.JS);
const checker = program.getTypeChecker();

function collectDeepNodes<T>(node: ts.Node, kind: ts.SyntaxKind): T[] {
  let nodes: T[] = [];
  let helper = (child: ts.Node) => {
    if (child.kind === kind) {
      nodes.push(child as any as T);
    }
    ts.forEachChild(child, helper);
  };
  ts.forEachChild(node, helper);
  return nodes;
}

function nameOfSpecifier(node: ts.ImportSpecifier): string {
  return node.name && node.name.text || '<unknown>';
}

function expect<T extends ts.Node>(node: ts.Node, kind: ts.SyntaxKind): T {
  if (node.kind !== kind) {
    throw 'Invalid!';
  }
  return node as T;
}

function findAngularMetadataImports(node: ts.Node): ts.ImportSpecifier[] {
  let specs: ts.ImportSpecifier[] = [];
  ts.forEachChild(node, (child) => {
    if (child.kind === ts.SyntaxKind.ImportDeclaration) {
      const importDecl = child as ts.ImportDeclaration;
      if (isAngularCoreImport(importDecl)) {
        specs.push(...collectDeepNodes<ts.ImportSpecifier>(node, ts.SyntaxKind.ImportSpecifier)
          .filter(spec => isAngularCoreSpecifier(spec)));
      }
    }
  });
  return specs;
}

function isAngularCoreImport(node: ts.ImportDeclaration): boolean {
  return true &&
    node.moduleSpecifier &&
    node.moduleSpecifier.kind === ts.SyntaxKind.StringLiteral &&
    (node.moduleSpecifier as ts.StringLiteral).text === '@angular/core';
}

const ANGULAR_SPECIFIERS = [
  'Component',
  'Directive',
  'Injectable',
  'NgModule',
  'Pipe',
];

function isAngularCoreSpecifier(node: ts.ImportSpecifier): boolean {
  return ANGULAR_SPECIFIERS.indexOf(nameOfSpecifier(node)) !== -1;
}

function isDecoratorAssignmentExpression(exprStmt: ts.ExpressionStatement): boolean {
  if (exprStmt.expression.kind !== ts.SyntaxKind.BinaryExpression) {
    return false;
  }
  const expr = exprStmt.expression as ts.BinaryExpression;
  if (expr.left.kind !== ts.SyntaxKind.PropertyAccessExpression) {
    return false;
  }
  const propAccess = expr.left as ts.PropertyAccessExpression;
  if (propAccess.expression.kind !== ts.SyntaxKind.Identifier) {
    return false;
  }
  if (propAccess.name.text !== 'decorators') {
    return false;
  }
  if (expr.operatorToken.kind !== ts.SyntaxKind.FirstAssignment) {
    return false;
  }
  if (expr.right.kind !== ts.SyntaxKind.ArrayLiteralExpression) {
    return false;
  }
  return true;
}

function pickDecorationNodesToRemove(exprStmt: ts.ExpressionStatement, ngMetadata: ts.ImportSpecifier[]): ts.Node[] {
  const expr = expect<ts.BinaryExpression>(exprStmt.expression, ts.SyntaxKind.BinaryExpression);
  const literal = expect<ts.ArrayLiteralExpression>(expr.right, ts.SyntaxKind.ArrayLiteralExpression);
  if (!literal.elements.every(elem => elem.kind === ts.SyntaxKind.ObjectLiteralExpression)) {
    return [];
  }
  const elements = literal.elements as ts.Node[] as ts.ObjectLiteralExpression[];
  const ngDecorators = elements.filter(elem => isAngularDecorator(elem, ngMetadata));
  return (elements.length > ngDecorators.length) ? ngDecorators : [exprStmt];
}

function isAngularDecorator(literal: ts.ObjectLiteralExpression, ngMetadata: ts.ImportSpecifier[]): boolean {
  const types = literal.properties.filter(isTypeProperty);
  if (types.length !== 1) {
    return false;
  }
  const assign = expect<ts.PropertyAssignment>(types[0], ts.SyntaxKind.PropertyAssignment);
  if (assign.initializer.kind !== ts.SyntaxKind.Identifier) {
    return false;
  }
  const id = assign.initializer as ts.Identifier;
  return identifierIsMetadata(id, ngMetadata);
}

function isTypeProperty(prop: ts.ObjectLiteralElement): boolean {
  if (prop.kind !== ts.SyntaxKind.PropertyAssignment) {
    return false;
  }
  const assignment = prop as ts.PropertyAssignment;
  if (assignment.name.kind !== ts.SyntaxKind.Identifier) {
    return false;
  }
  const name = assignment.name as ts.Identifier;
  return name.text === 'type';
}

function identifierIsMetadata(id: ts.Identifier, metadata: ts.ImportSpecifier[]): boolean {
  const symbol = checker.getSymbolAtLocation(id);
  if (!symbol || !symbol.declarations || !symbol.declarations.length) {
    return false;
  }
  return symbol
    .declarations
    .filter(spec => spec.kind === ts.SyntaxKind.ImportSpecifier)
    .some(spec => metadata.indexOf(spec as ts.ImportSpecifier) !== -1);
}

const ngMetadata = findAngularMetadataImports(source);

let nodes: ts.Node[] = [];
ts.forEachChild(source, node => {
  if (node.kind !== ts.SyntaxKind.ExpressionStatement) {
    return;
  }
  if (isDecoratorAssignmentExpression(node as ts.ExpressionStatement)) {
    nodes.push(...pickDecorationNodesToRemove(node as ts.ExpressionStatement, ngMetadata));
  }
});

function repeatSpace(count: number) {
  let space = '';
  for (let i = 0; i < count; i++) {
    space += ' ';
  }
  return space;
}

function replaceSubstr(initial: string, begin: number, end: number): string {
  const before = initial.substring(0, begin);
  const after = initial.substring(end + 1);

  return before + repeatSpace(end - begin) + '\n' + after;
}

nodes.forEach(node => {
  contents = replaceSubstr(contents, node.getStart(), node.getEnd());
});

process.stdout.write(contents);
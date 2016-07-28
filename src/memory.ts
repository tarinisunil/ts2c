import * as ts from 'typescript';
import {TypeHelper, ArrayType, StructType, StringVarType} from './types';

type VariableScopeInfo = {
    node: ts.Node;
    simple: boolean,
    array: boolean;
    varName: string;
    scopeId: string;
};

export class MemoryManager {
    private scopes: { [scopeId: string]: VariableScopeInfo[] } = {};
    private scopesOfVariables: { [key: string]: VariableScopeInfo } = {};

    constructor(private typeChecker: ts.TypeChecker, private typeHelper: TypeHelper) { }

    public preprocessVariables() {

        for (let k in this.typeHelper.variables) {
            let v = this.typeHelper.variables[k];
            if (v.requiresAllocation)
                this.scheduleNodeDisposal(v.declaration.name);
        }

    }

    public preprocessTemporaryVariables(node: ts.Node) {
        switch (node.kind) {
            case ts.SyntaxKind.ArrayLiteralExpression:
                {
                    if (node.parent.kind == ts.SyntaxKind.VariableDeclaration)
                        return;

                    let type = this.typeHelper.getCType(node);
                    if (type && type instanceof ArrayType && type.isDynamicArray)
                        this.scheduleNodeDisposal(node);
                }
                break;
            case ts.SyntaxKind.BinaryExpression:
                {
                    let binExpr = <ts.BinaryExpression>node;
                    if (binExpr.operatorToken.kind == ts.SyntaxKind.PlusToken) {
                        let leftType = this.typeHelper.getCType(binExpr.left);
                        let rightType = this.typeHelper.getCType(binExpr.right);
                        if (leftType == StringVarType || rightType == StringVarType)
                            this.scheduleNodeDisposal(binExpr);

                        if (binExpr.left.kind == ts.SyntaxKind.BinaryExpression)
                            this.preprocessTemporaryVariables(binExpr.left);
                        if (binExpr.right.kind == ts.SyntaxKind.BinaryExpression)
                            this.preprocessTemporaryVariables(binExpr.right);

                        return;
                    }
                }
                break;
        }
        node.getChildren().forEach(c => this.preprocessTemporaryVariables(c));
    }

    public getGCVariablesForScope(node: ts.Node) {
        let parentDecl = this.findParentFunctionNode(node);
        var scopeId: string = parentDecl && parentDecl.pos + 1 + "" || "main";
        let realScopeId = this.scopes[scopeId] && this.scopes[scopeId].length && this.scopes[scopeId][0].scopeId
        let gcVars = [];
        if (this.scopes[scopeId] && this.scopes[scopeId].filter(v => !v.simple && !v.array).length) {
            gcVars.push("_gc_" + realScopeId);
        }
        if (this.scopes[scopeId] && this.scopes[scopeId].filter(v => !v.simple && v.array).length) {
            gcVars.push("_gc_" + realScopeId + "_arrays");
        }
        return gcVars;
    }

    public getGCVariableForNode(node: ts.Node) {
        let parentDecl = this.findParentFunctionNode(node);
        let key = node.pos + "_" + node.end;

        if (this.scopesOfVariables[key] && !this.scopesOfVariables[key].simple)
            return "_gc_" + this.scopesOfVariables[key].scopeId + (this.scopesOfVariables[key].array ? "_arrays" : "");
        else
            return null;
    }

    public getDestructorsForScope(node: ts.Node) {
        let parentDecl = this.findParentFunctionNode(node);
        let scopeId = parentDecl && parentDecl.pos + 1 || "main";
        let destructors: { node: ts.Node, varName: string }[] = [];
        if (this.scopes[scopeId]) {
            for (let simpleVarScopeInfo of this.scopes[scopeId].filter(v => v.simple)) {
                destructors.push({ node: simpleVarScopeInfo.node, varName: simpleVarScopeInfo.varName });
            }
        }
        return destructors;
    }

    public getReservedTemporaryVarName(node: ts.Node) {
        return this.scopesOfVariables[node.pos + "_" + node.end].varName;
    }

    private scheduleNodeDisposal(heapNode: ts.Node) {

        let varFuncNode = this.findParentFunctionNode(heapNode);
        var topScope: number | "main" = varFuncNode && varFuncNode.pos + 1 || "main"
        var isSimple = true;

        var scopeTree = {};
        scopeTree[topScope] = true;

        // TODO:
        // - circular references

        var queue = [heapNode];
        queue.push();
        while (queue.length > 0) {
            let node = queue.shift();

            let refs = [node];
            if (node.kind == ts.SyntaxKind.Identifier) {
                let varIdent = <ts.Identifier>node;
                let nodeVarInfo = this.typeHelper.getVariableInfo(varIdent);
                if (!nodeVarInfo) {
                    console.log("WARNING: Cannot find references for " + node.getText());
                    continue;
                }
                refs = this.typeHelper.getVariableInfo(varIdent).references;
            }
            let returned = false;
            for (let ref of refs) {
                let parentNode = this.findParentFunctionNode(ref);
                if (!parentNode)
                    topScope = "main";

                if (ref.parent && ref.parent.kind == ts.SyntaxKind.BinaryExpression) {
                    let binaryExpr = <ts.BinaryExpression>ref.parent;
                    if (binaryExpr.operatorToken.kind == ts.SyntaxKind.EqualsToken && binaryExpr.left.getText() == heapNode.getText()) {
                        console.log(heapNode.getText() + " -> Detected assignment: " + binaryExpr.getText() + ".");
                        isSimple = false;
                    }
                }

                if (ref.parent && ref.parent.kind == ts.SyntaxKind.CallExpression) {
                    let call = <ts.CallExpression>ref.parent;
                    if (call.expression.kind == ts.SyntaxKind.Identifier && call.expression.pos == ref.pos) {
                        console.log(heapNode.getText() + " -> Found function call!");
                        if (topScope !== "main") {
                            let funcNode = this.findParentFunctionNode(call);
                            topScope = funcNode && funcNode.pos + 1 || "main";
                            let targetScope = node.parent.pos + 1 + "";
                            isSimple = false;
                            if (scopeTree[targetScope])
                                delete scopeTree[targetScope];
                            scopeTree[topScope] = targetScope;
                        }
                        this.addIfFoundInAssignment(heapNode, call, queue);
                    } else {
                        let symbol = this.typeChecker.getSymbolAtLocation(call.expression);
                        if (!symbol) {
                            if (call.expression.getText() != "console.log") {
                                let isPush = false;
                                if (call.expression.kind == ts.SyntaxKind.PropertyAccessExpression) {
                                    let propAccess = <ts.PropertyAccessExpression>call.expression;
                                    let type = this.typeHelper.getCType(propAccess.expression);
                                    if (type && (type instanceof ArrayType) && propAccess.name.getText() == "push")
                                        isPush = true;
                                }

                                if (isPush) {
                                    console.log("WARNING: " + heapNode.getText() + " is pushed to an array ('" + call.getText() + "'), but this scenario is not yet supported by memory manager!");
                                }
                                else {
                                    console.log(heapNode.getText() + " -> Detected passing to external function " + call.expression.getText() + ". Scope changed to main.");
                                    topScope = "main";
                                    isSimple = false;
                                }
                            }
                        }
                        else {
                            let funcDecl = <ts.FunctionDeclaration>symbol.valueDeclaration;
                            for (let i = 0; i < call.arguments.length; i++) {
                                if (call.arguments[i].kind == ts.SyntaxKind.Identifier && call.arguments[i].getText() == node.getText()) {
                                    console.log(heapNode.getText() + " -> Found passing to function " + call.expression.getText() + " as parameter " + funcDecl.parameters[i].name.getText());
                                    queue.push(<ts.Identifier>funcDecl.parameters[i].name);
                                    isSimple = false;
                                }
                            }
                        }
                    }
                }
                else if (ref.parent && ref.parent.kind == ts.SyntaxKind.ReturnStatement && !returned) {
                    returned = true;
                    queue.push(parentNode.name);
                    console.log(heapNode.getText() + " -> Found variable returned from the function!");
                    isSimple = false;
                }
                else
                    this.addIfFoundInAssignment(heapNode, ref, queue)
            }

        }

        var type = this.typeHelper.getCType(heapNode);
        let varName: string;
        if (heapNode.kind == ts.SyntaxKind.ArrayLiteralExpression)
            varName = this.typeHelper.addNewTemporaryVariable(heapNode, "tmp_array");
        else if (heapNode.kind == ts.SyntaxKind.BinaryExpression)
            varName = this.typeHelper.addNewTemporaryVariable(heapNode, "tmp_string");
        else
            varName = heapNode.getText();

        let foundScopes = topScope == "main" ? [topScope] : Object.keys(scopeTree);
        var scopeInfo = {
            node: heapNode,
            simple: isSimple,
            array: type && type instanceof ArrayType && type.isDynamicArray,
            varName: varName,
            scopeId: foundScopes.join("_")
        };
        this.scopesOfVariables[heapNode.pos + "_" + heapNode.end] = scopeInfo;

        for (let sc of foundScopes) {
            this.scopes[sc] = this.scopes[sc] || [];
            this.scopes[sc].push(scopeInfo);
        }

    }

    private addIfFoundInAssignment(varIdent: ts.Node, ref: ts.Node, queue: ts.Node[]): boolean {
        if (ref.parent && ref.parent.kind == ts.SyntaxKind.VariableDeclaration) {
            let varDecl = <ts.VariableDeclaration>ref.parent;
            if (varDecl.initializer && varDecl.initializer.pos == ref.pos) {
                queue.push(varDecl.name);
                console.log(varIdent.getText() + " -> Found initializer-assignment to variable " + varDecl.name.getText());
                return true;
            }
        }
        else if (ref.parent && ref.parent.kind == ts.SyntaxKind.BinaryExpression) {
            let binaryExpr = <ts.BinaryExpression>ref.parent;
            if (binaryExpr.operatorToken.kind == ts.SyntaxKind.FirstAssignment && binaryExpr.right.pos == ref.pos) {
                // TODO: process non-identifier left hand side expressions
                queue.push(binaryExpr.left);
                console.log(varIdent.getText() + " -> Found assignment to variable " + binaryExpr.left.getText());
                return true;
            }
        }

        return false;
    }

    private findParentFunctionNode(node: ts.Node) {
        var parent = node;
        while (parent && parent.kind != ts.SyntaxKind.FunctionDeclaration) {
            parent = parent.parent;
        }
        return <ts.FunctionDeclaration>parent;
    }

    private getSymbolId(node: ts.Node) {
        return this.typeChecker.getSymbolAtLocation(node)["id"];
    }

}
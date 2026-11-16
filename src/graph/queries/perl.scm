; Perl: `sub name { ... }` and `package Name;`. A call written with parentheses,
; with or without `&`, or a method call, names its sub; a qualified
; `Foo::bar()` keeps its package in the name and stays unresolved rather than
; guessed, and a call through a code reference (`&$f()`) names nothing.
(subroutine_declaration_statement
  name: (bareword) @name) @definition.function

(package_statement
  name: (package) @name) @definition.module

(function_call_expression
  function: (function) @name
  (#match? @name "^[A-Za-z_]")) @reference.call

(function_call_expression
  function: (function
    (varname) @name)
  (#match? @name "^[A-Za-z_]")) @reference.call

(method_call_expression
  method: (method) @name) @reference.call

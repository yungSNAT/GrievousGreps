; Perl: `sub name { ... }` and `package Name;`. A call written with parentheses,
; with or without `&`, or a method call on a variable (`$obj->go`), names its
; sub; a qualified `Foo::bar()` keeps its package in the name and stays
; unresolved rather than guessed, a class method (`Foo->new`, `__PACKAGE__->new`)
; names a package's sub that no name alone settles, and a call through a code
; reference (`&$f()`) names nothing.
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
  invocant: (_) @receiver
  method: (method) @name
  (#match? @receiver "^[$]")) @reference.call

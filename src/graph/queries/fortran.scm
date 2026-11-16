; Fortran: functions, subroutines, modules and programs, each over its whole
; body so the calls inside belong to it. `call name(...)` and `name(...)` in an
; expression are calls; array indexing reads the same, and names no procedure.
(function
  (function_statement
    name: (name) @name)) @definition.function

(subroutine
  (subroutine_statement
    name: (name) @name)) @definition.function

(module
  (module_statement
    (name) @name)) @definition.module

(program
  (program_statement
    (name) @name)) @definition.module

(call_expression
  .
  (identifier) @name) @reference.call

(subroutine_call
  subroutine: (identifier) @name) @reference.call

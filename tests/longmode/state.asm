; State images of a cpu in long mode (see state.js).
;
; Sets up registers that only exist with their full width in long mode, writes 'A' to the serial
; port and spins until the byte at FLAG is set. state.js saves the state at 'A', restores it into
; a new emulator and sets the flag. The values read back are stored as qwords at RESULTS (the
; ones read before the save at BEFORE); 'K' is written to the serial port when done.
;
; The idtr and gdtr bases point to unmapped addresses: no interrupt is taken and no segment
; register is loaded while they are in place.

org 0xF0000

%define RESULTS 0x90000
%define BEFORE 0x90100
%define FLAG 0x9000

%macro WRMSR64 2
    mov ecx, %1
    mov eax, (%2) & 0xFFFFFFFF
    mov edx, (%2) >> 32
    wrmsr
%endmacro

; store the 64-bit value of an msr at [r15 + %2*8]
%macro RDMSR64 2
    mov ecx, %1
    rdmsr
    shl rdx, 32
    or rax, rdx
    mov [r15 + %2*8], rax
%endmacro

[bits 16]
start16:
    cli

    ; page tables: PML4 @0x1000, PDPT @0x2000, PD @0x3000 (0..256 MiB), PD @0x4000 (3..4 GiB)
    mov edi, 0x1000
    mov ecx, 0x1000
zero_tables:
    mov dword [edi], 0
    add edi, 4
    dec ecx
    jnz zero_tables

    mov dword [0x1000], 0x2007
    mov dword [0x2000], 0x3007
    mov dword [0x2018], 0x4007

    xor eax, eax
    mov edi, 0x3000
    mov ecx, 128
fill_pd:
    mov edx, eax
    shl edx, 21
    or  edx, 0x87
    mov [edi], edx
    inc eax
    add edi, 8
    dec ecx
    jnz fill_pd

    ; GDT at 0x800: null, 64-bit code (0x08), data (0x10)
    xor eax, eax
    mov edi, 0x800
    mov ecx, 6
zero_gdt:
    mov dword [edi], 0
    add edi, 4
    dec ecx
    jnz zero_gdt
    mov dword [0x808], 0x0000FFFF
    mov dword [0x80C], 0x00AF9A00
    mov dword [0x810], 0x0000FFFF
    mov dword [0x814], 0x00CF9200

    a32 lgdt [gdt_ptr]

    mov eax, cr4
    or  eax, 1 << 5              ; CR4.PAE
    mov cr4, eax

    mov ecx, 0xC0000080          ; IA32_EFER
    rdmsr
    or  eax, 0x100               ; EFER.LME
    wrmsr

    mov eax, 0x1000
    mov cr3, eax

    mov eax, cr0
    or  eax, 0x80000001          ; CR0.PE|CR0.PG
    mov cr0, eax

    o32 jmp 0x08:longmode

[bits 64]
longmode:
    mov ax, 0x10
    mov ds, ax
    mov es, ax
    mov ss, ax
    mov rsp, 0x80000
    mov qword [abs FLAG], 0

    WRMSR64 0xC0000081, 0x0023001000000000  ; star
    WRMSR64 0xC0000082, 0xFFFFFFFF81000080  ; lstar
    WRMSR64 0xC0000083, 0xFFFFFFFF81001640  ; cstar
    WRMSR64 0xC0000084, 0x0000000000257FD5  ; sfmask
    WRMSR64 0xC0000100, 0x00007F1234567000  ; fs base
    WRMSR64 0xC0000101, 0xFFFF888012345000  ; gs base
    WRMSR64 0xC0000102, 0x00007F7654321000  ; kernel gs base
    mov rax, 0xFFFF800012345678
    mov cr2, rax
    lidt [rel idt_ptr]
    lgdt [rel gdt_ptr64]
    mov r12, 0x1122334455667788

    mov r15, BEFORE
    call read_back

    ; lazy flags of a 64-bit operation, pending across the save: CF, PF, ZF and OF. Nothing
    ; below changes the flags until they are read.
    mov rax, 0x8000000000000000
    mov rbx, rax
    add rax, rbx

    mov dx, 0x3F8
    mov al, 'A'
    out dx, al
wait_for_flag:
    mov rcx, [abs FLAG]
    jrcxz wait_for_flag

    pushfq
    pop rax
    and eax, 0x8C5
    mov r15, RESULTS
    mov [r15 + 0*8], rax
    call read_back

    mov dx, 0x3F8
    mov al, 'K'
    out dx, al
done:
    cli
    hlt
    jmp done

read_back:
    RDMSR64 0xC0000081, 1
    RDMSR64 0xC0000082, 2
    RDMSR64 0xC0000083, 3
    RDMSR64 0xC0000084, 4
    RDMSR64 0xC0000100, 5
    RDMSR64 0xC0000101, 6
    RDMSR64 0xC0000102, 7
    mov rax, cr2
    mov [r15 + 8*8], rax
    sidt [abs 0x9100]
    mov rax, [abs 0x9102]
    mov [r15 + 9*8], rax
    sgdt [abs 0x9100]
    mov rax, [abs 0x9102]
    mov [r15 + 10*8], rax
    mov [r15 + 11*8], r12
    ret

idt_ptr:
    dw 0xFFF
    dq 0xFFFFFE0000000000

gdt_ptr64:
    dw 0x17
    dq 0xFFFFFE0000001000

gdt_ptr:
    dw 0x17
    dd 0x800

[bits 16]
    times 0xFFF0 - ($ - $$) db 0x90
reset_vector:
    jmp 0xF000:start16 - 0xF0000
    times 16 - 5 db 0x90
